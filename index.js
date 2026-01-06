/**
 * Homebridge Philips Air Purifier Plugin
 * 
 * Controls Philips Air Purifiers via CoAP protocol using a persistent
 * Python daemon with CoAP Observe for real-time push updates.
 * 
 * Architecture:
 * - Python daemon maintains a CoAP Observe subscription
 * - Device pushes state updates (~every 30s or on change)
 * - Commands (power, mode, light, etc.) are sent directly and are fast
 * - State reads use cached data from observe updates (instant)
 */

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

let Service, Characteristic;

// Constants for device values
const MODE = {
  AUTO: 0,
  SLEEP: 17,
  TURBO: 18,
  MEDIUM: 19,
};

const MODE_NAME = {
  [MODE.AUTO]: 'auto',
  [MODE.SLEEP]: 'sleep',
  [MODE.TURBO]: 'turbo',
  [MODE.MEDIUM]: 'medium',
};

const LIGHT = {
  OFF: 0,
  DIM: 115,
  BRIGHT: 123,
};

// Map rotation speed percentage to mode
const SPEED_TO_MODE = [
  { max: 0, mode: null },      // 0% = turn off
  { max: 33, mode: 'sleep' },  // 1-33% = sleep
  { max: 66, mode: 'medium' }, // 34-66% = medium
  { max: 100, mode: 'turbo' }, // 67-100% = turbo
];

// Map mode to rotation speed percentage
const MODE_TO_SPEED = {
  auto: 100,
  sleep: 16,
  medium: 50,
  turbo: 83,
};

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory(
    'homebridge-philips-air-purifier',
    'PhilipsAirPurifier',
    PhilipsAirPurifierAccessory
  );
};

/**
 * Daemon communication handler with CoAP Observe support.
 * 
 * The daemon uses CoAP Observe to receive push updates from the device.
 * State reads are instant (cached), commands are sent directly.
 */
class DaemonHandler {
  constructor(log, onUpdate) {
    this.log = log;
    this.onUpdate = onUpdate; // Callback for observe updates
    this.daemon = null;
    this.rl = null;
    this.connected = false;
    this.observing = false;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.commandTimeout = 15000; // 15 seconds for commands (they're fast)
  }

  /**
   * Start the Python daemon process.
   */
  async start(pythonPath, scriptPath, host) {
    return new Promise((resolve, reject) => {
      this.log.info(`Starting observe daemon: ${pythonPath} ${scriptPath} ${host} --daemon`);
      
      this.daemon = spawn(pythonPath, [scriptPath, host, '--daemon'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      this.daemon.on('error', (err) => {
        this.log.error(`Daemon process error: ${err.message}`);
        this.connected = false;
        this.observing = false;
      });

      this.daemon.on('exit', (code, signal) => {
        this.log.warn(`Daemon exited with code ${code}, signal ${signal}`);
        this.connected = false;
        this.observing = false;
        this.daemon = null;
        
        // Reject all pending requests
        for (const [id, { reject }] of this.pendingRequests) {
          reject(new Error('Daemon exited'));
        }
        this.pendingRequests.clear();
      });

      // Handle stderr for logging
      this.daemon.stderr.on('data', (data) => {
        this.log.debug(`Daemon stderr: ${data.toString().trim()}`);
      });

      // Setup readline for stdout
      this.rl = readline.createInterface({
        input: this.daemon.stdout,
        terminal: false
      });

      this.rl.on('line', (line) => {
        this.handleMessage(line);
      });

      // Wait for ready signal
      const timeout = setTimeout(() => {
        reject(new Error('Daemon startup timeout'));
      }, 20000); // 20s timeout for initial connection + first observe

      const readyHandler = (line) => {
        try {
          const response = JSON.parse(line);
          if (response.type === 'ready') {
            clearTimeout(timeout);
            this.rl.removeListener('line', readyHandler);
            
            this.connected = response.connected;
            if (response.connected) {
              this.log.info('Daemon ready, waiting for first observe update...');
            } else {
              this.log.warn(`Daemon ready but not connected: ${response.error}`);
            }
            resolve(response.connected);
          }
        } catch (e) {
          // Not the ready message, ignore
        }
      };

      this.rl.on('line', readyHandler);
    });
  }

  /**
   * Stop the daemon process.
   */
  stop() {
    if (this.daemon) {
      this.daemon.kill('SIGTERM');
      this.daemon = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.connected = false;
    this.observing = false;
  }

  /**
   * Handle a message from the daemon.
   */
  handleMessage(line) {
    try {
      const message = JSON.parse(line);
      
      // Handle different message types
      switch (message.type) {
        case 'update':
          // Push update from CoAP Observe
          this.observing = true;
          this.log.debug(`Observe update received: pm25=${message.data?.pm25}`);
          if (this.onUpdate) {
            this.onUpdate(message.data);
          }
          break;
          
        case 'log':
          this.log.debug(`Daemon: [${message.event}] ${message.message}`);
          break;
          
        case 'error':
          this.log.error(`Daemon error: ${message.error}`);
          break;
          
        case 'shutdown':
          this.log.info('Daemon shutdown');
          this.connected = false;
          this.observing = false;
          break;
          
        default:
          // Handle request responses (have an 'id' field)
          if (message.id !== undefined && this.pendingRequests.has(message.id)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(message.id);
            clearTimeout(timeout);
            this.pendingRequests.delete(message.id);
            
            if (message.success) {
              resolve(message.data);
            } else {
              reject(new Error(message.error || 'Command failed'));
            }
          }
          break;
      }
    } catch (e) {
      this.log.debug(`Failed to parse daemon message: ${line}`);
    }
  }

  /**
   * Send a command to the daemon.
   */
  async execute(cmd, args = []) {
    if (!this.daemon) {
      throw new Error('Daemon not running');
    }

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command timeout: ${cmd}`));
      }, this.commandTimeout);
      
      this.pendingRequests.set(id, { resolve, reject, timeout });
      
      const request = JSON.stringify({ id, cmd, args });
      this.log.debug(`Sending command: ${request}`);
      this.daemon.stdin.write(request + '\n');
    });
  }
}

/**
 * Main accessory class for Philips Air Purifier.
 */
class PhilipsAirPurifierAccessory {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'Air Purifier';
    this.host = config.host;

    if (!this.host) {
      throw new Error('host is required in config');
    }

    const pluginDir = __dirname;
    this.apiScriptPath = config.apiScriptPath || path.join(pluginDir, 'philips_air_api.py');
    this.pythonPath = config.pythonPath || this.findPython(pluginDir);

    if (!fs.existsSync(this.apiScriptPath)) {
      throw new Error(`Python API script not found at: ${this.apiScriptPath}`);
    }

    this.log.info(`Using Python: ${this.pythonPath}`);
    this.log.info(`Using API script: ${this.apiScriptPath}`);

    // Device state
    this.state = {
      power: false,
      mode: 'auto',
      lightLevel: LIGHT.OFF,
      childLock: false,
      pm25: 0,
      iaql: 0,
      filterLifePercent: 100,
      cleanupPercent: 100,
      temperature: null,
      humidity: null,
    };

    // Track device reachability
    this.deviceReachable = false;
    this.lastLightLevel = LIGHT.BRIGHT;
    this.lastUpdateTime = 0;
    this.lastPower = null;
    this.lastMode = null;
    
    // Daemon handler with observe callback
    this.daemon = new DaemonHandler(log, this.handleObserveUpdate.bind(this));
    
    // Command lock (prevent state updates during command execution)
    this.commandLock = false;

    this.setupServices();
    this.startDaemon();
  }

  /**
   * Find Python with aioairctrl installed.
   */
  findPython(pluginDir) {
    const candidates = [
      path.join(pluginDir, '.venv', 'bin', 'python3'),
      path.join(pluginDir, 'venv', 'bin', 'python3'),
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      'python3',
    ];

    for (const pythonPath of candidates) {
      if (fs.existsSync(pythonPath) || pythonPath === 'python3') {
        try {
          const { execSync } = require('child_process');
          execSync(`${pythonPath} -c "import aioairctrl"`, { stdio: 'ignore' });
          this.log.debug(`Found Python with aioairctrl: ${pythonPath}`);
          return pythonPath;
        } catch (e) {
          continue;
        }
      }
    }

    this.log.warn('Could not find Python with aioairctrl installed');
    return 'python3';
  }

  /**
   * Start the Python daemon.
   */
  async startDaemon() {
    try {
      const connected = await this.daemon.start(
        this.pythonPath,
        this.apiScriptPath,
        this.host
      );
      
      this.deviceReachable = connected;
      this.updateReachabilityStatus();
      
      this.log.info('Daemon started, waiting for observe updates...');
    } catch (error) {
      this.log.error(`Failed to start daemon: ${error.message}`);
      this.deviceReachable = false;
      this.updateReachabilityStatus();
    }
  }

  /**
   * Handle a state update from CoAP Observe.
   */
  handleObserveUpdate(sensors) {
    // Skip updates while a command is in progress
    if (this.commandLock) {
      this.log.debug('Skipping observe update - command in progress');
      return;
    }

    // Update state from sensors
    this.state.power = sensors.power;
    this.state.mode = this.normalizeMode(sensors.mode);
    this.state.lightLevel = sensors.light_level;
    this.state.childLock = sensors.child_lock;
    this.state.pm25 = sensors.pm25 || 0;
    this.state.iaql = sensors.iaql || 0;
    this.state.filterLifePercent = sensors.filter_life_percent || 100;
    this.state.cleanupPercent = sensors.cleanup_percent || 100;
    this.state.temperature = sensors.temperature;
    this.state.humidity = sensors.humidity;

    // Track last light level
    if (this.state.lightLevel > 0) {
      this.lastLightLevel = this.state.lightLevel;
    }

    // Mark as reachable and log first update or significant changes
    const wasReachable = this.deviceReachable;
    const powerChanged = this.lastPower !== this.state.power;
    const modeChanged = this.lastMode !== this.state.mode;
    
    if (!wasReachable) {
      this.deviceReachable = true;
      this.log.info(`Device connected: power=${this.state.power ? 'ON' : 'OFF'}, mode=${this.state.mode}, pm25=${this.state.pm25}`);
    } else if (powerChanged || modeChanged) {
      this.log.info(`Status changed: power=${this.state.power ? 'ON' : 'OFF'}, mode=${this.state.mode}`);
    }
    
    this.lastPower = this.state.power;
    this.lastMode = this.state.mode;
    this.lastUpdateTime = Date.now();

    // Update all characteristics
    this.updatePurifierCharacteristics();
    this.updateLightCharacteristics();
    this.updateAirQualityCharacteristics();
    this.updateFilterCharacteristics();
  }

  /**
   * Setup all HomeKit services.
   */
  setupServices() {
    // Accessory Information
    this.informationService = new Service.AccessoryInformation();
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Philips')
      .setCharacteristic(Characteristic.Model, 'Air Purifier')
      .setCharacteristic(Characteristic.SerialNumber, this.host);

    // Main Air Purifier Service
    this.purifierService = new Service.AirPurifier(this.name);

    this.purifierService
      .getCharacteristic(Characteristic.Active)
      .on('get', this.handleGet.bind(this, 'Active'))
      .on('set', this.handleSetPower.bind(this));

    this.purifierService
      .getCharacteristic(Characteristic.CurrentAirPurifierState)
      .on('get', this.handleGet.bind(this, 'CurrentAirPurifierState'));

    this.purifierService
      .getCharacteristic(Characteristic.TargetAirPurifierState)
      .on('get', this.handleGet.bind(this, 'TargetAirPurifierState'))
      .on('set', this.handleSetTargetState.bind(this));

    this.purifierService
      .addCharacteristic(Characteristic.RotationSpeed)
      .on('get', this.handleGet.bind(this, 'RotationSpeed'))
      .on('set', this.handleSetRotationSpeed.bind(this));

    // Child Lock (LockPhysicalControls)
    this.purifierService
      .addCharacteristic(Characteristic.LockPhysicalControls)
      .on('get', this.handleGet.bind(this, 'LockPhysicalControls'))
      .on('set', this.handleSetChildLock.bind(this));

    // Air Quality Sensor
    this.airQualitySensor = new Service.AirQualitySensor('Air Quality');
    this.airQualitySensor
      .getCharacteristic(Characteristic.AirQuality)
      .on('get', this.handleGet.bind(this, 'AirQuality'));
    this.airQualitySensor
      .addCharacteristic(Characteristic.PM2_5Density)
      .on('get', this.handleGet.bind(this, 'PM2_5Density'));

    // HEPA Filter Maintenance
    this.hepaFilterService = new Service.FilterMaintenance('HEPA Filter', 'hepa-filter');
    this.hepaFilterService
      .getCharacteristic(Characteristic.FilterLifeLevel)
      .on('get', this.handleGet.bind(this, 'HEPAFilterLifeLevel'));
    this.hepaFilterService
      .getCharacteristic(Characteristic.FilterChangeIndication)
      .on('get', this.handleGet.bind(this, 'HEPAFilterChangeIndication'));

    // Pre-Filter Maintenance (cleanup indicator)
    this.preFilterService = new Service.FilterMaintenance('Pre-Filter', 'pre-filter');
    this.preFilterService
      .getCharacteristic(Characteristic.FilterLifeLevel)
      .on('get', this.handleGet.bind(this, 'PreFilterLifeLevel'));
    this.preFilterService
      .getCharacteristic(Characteristic.FilterChangeIndication)
      .on('get', this.handleGet.bind(this, 'PreFilterChangeIndication'));

    // Display Light
    this.lightService = new Service.Lightbulb('Display Light');
    this.lightService
      .getCharacteristic(Characteristic.On)
      .on('get', this.handleGet.bind(this, 'LightOn'))
      .on('set', this.handleSetLightOn.bind(this));
    this.lightService
      .addCharacteristic(Characteristic.Brightness)
      .on('get', this.handleGet.bind(this, 'LightBrightness'))
      .on('set', this.handleSetLightBrightness.bind(this));

    // Link secondary services to primary
    this.purifierService.addLinkedService(this.airQualitySensor);
    this.purifierService.addLinkedService(this.hepaFilterService);
    this.purifierService.addLinkedService(this.preFilterService);
    this.purifierService.addLinkedService(this.lightService);
  }

  /**
   * Generic getter for characteristics.
   */
  handleGet(characteristic, callback) {
    const value = this.getCharacteristicValue(characteristic);
    this.log.debug(`[GET] ${characteristic}: ${value}`);
    callback(null, value);
  }

  /**
   * Get the current value for a characteristic.
   */
  getCharacteristicValue(characteristic) {
    switch (characteristic) {
      case 'Active':
        return this.state.power ? 1 : 0;
      
      case 'CurrentAirPurifierState':
        return this.state.power
        ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
        : Characteristic.CurrentAirPurifierState.INACTIVE;
      
      case 'TargetAirPurifierState':
        return this.state.mode === 'auto'
        ? Characteristic.TargetAirPurifierState.AUTO
        : Characteristic.TargetAirPurifierState.MANUAL;
      
      case 'RotationSpeed':
        return MODE_TO_SPEED[this.state.mode] || 100;
      
      case 'LockPhysicalControls':
        return this.state.childLock
          ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
          : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
      
      case 'AirQuality':
        return this.pm25ToAirQuality(this.state.pm25);
      
      case 'PM2_5Density':
        return this.state.pm25 || 0;
      
      case 'HEPAFilterLifeLevel':
        return Math.round(this.state.filterLifePercent);
      
      case 'HEPAFilterChangeIndication':
        return this.state.filterLifePercent < 10
          ? Characteristic.FilterChangeIndication.CHANGE_FILTER
          : Characteristic.FilterChangeIndication.FILTER_OK;
      
      case 'PreFilterLifeLevel':
        return Math.round(this.state.cleanupPercent);
      
      case 'PreFilterChangeIndication':
        return this.state.cleanupPercent < 10
          ? Characteristic.FilterChangeIndication.CHANGE_FILTER
          : Characteristic.FilterChangeIndication.FILTER_OK;
      
      case 'LightOn':
        return this.state.lightLevel > 0;
      
      case 'LightBrightness':
        if (this.state.lightLevel === LIGHT.OFF) return 0;
        if (this.state.lightLevel === LIGHT.DIM) return 50;
        return 100;
      
      default:
        return null;
    }
  }

  /**
   * Convert PM2.5 value to HomeKit AirQuality enum.
   */
  pm25ToAirQuality(pm25) {
    if (!pm25 || pm25 === 0) return Characteristic.AirQuality.UNKNOWN;
    if (pm25 <= 12) return Characteristic.AirQuality.EXCELLENT;
    if (pm25 <= 35) return Characteristic.AirQuality.GOOD;
    if (pm25 <= 55) return Characteristic.AirQuality.FAIR;
    if (pm25 <= 100) return Characteristic.AirQuality.INFERIOR;
    return Characteristic.AirQuality.POOR;
  }

  /**
   * Normalize mode value from device to string.
   */
  normalizeMode(mode) {
    if (typeof mode === 'string') {
      return mode.toLowerCase();
    }
    return MODE_NAME[mode] || 'auto';
  }

  /**
   * Execute a command with optimistic update.
   * Sets the state immediately, sends command, then waits for observe confirmation.
   */
  async executeCommand(cmd, args, optimisticState = {}) {
    this.commandLock = true;
    
    // Apply optimistic state
    Object.assign(this.state, optimisticState);
    
    try {
      await this.daemon.execute(cmd, args);
      this.log.debug(`Command ${cmd} succeeded`);
    } catch (error) {
      this.log.error(`Command ${cmd} failed: ${error.message}`);
      throw error;
    } finally {
      // Unlock after a short delay to let device process
      setTimeout(() => {
        this.commandLock = false;
      }, 500);
    }
  }

  /**
   * Set power state.
   */
  async handleSetPower(value, callback) {
    const powerOn = value === 1;
    this.log.info(`[SET] Power: ${powerOn ? 'ON' : 'OFF'}`);

    try {
      await this.executeCommand('power', [powerOn ? 'on' : 'off'], { power: powerOn });
      this.updatePurifierCharacteristics();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  /**
   * Set target state (auto/manual).
   */
  async handleSetTargetState(value, callback) {
    const isAuto = value === Characteristic.TargetAirPurifierState.AUTO;
    const mode = isAuto ? 'auto' : 'medium';
    this.log.info(`[SET] TargetState: ${isAuto ? 'AUTO' : 'MANUAL'}`);

    try {
      // Turn on if off
      if (!this.state.power) {
        await this.executeCommand('power', ['on'], { power: true });
      }

      await this.executeCommand('mode', [mode], { mode });
      this.updatePurifierCharacteristics();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  /**
   * Set rotation speed (maps to mode).
   */
  async handleSetRotationSpeed(value, callback) {
    this.log.info(`[SET] RotationSpeed: ${value}%`);

    try {
      // Speed 0 = turn off
      if (value === 0) {
        await this.executeCommand('power', ['off'], { power: false });
      } else {
        // Turn on if off
        if (!this.state.power) {
          await this.executeCommand('power', ['on'], { power: true });
        }

        // Find mode for speed
        let mode = 'medium';
        for (const { max, mode: m } of SPEED_TO_MODE) {
          if (value <= max && m !== null) {
            mode = m;
            break;
          }
        }

        await this.executeCommand('mode', [mode], { mode });
      }

      this.updatePurifierCharacteristics();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  /**
   * Set child lock.
   */
  async handleSetChildLock(value, callback) {
    const enabled = value === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
    this.log.info(`[SET] ChildLock: ${enabled ? 'ENABLED' : 'DISABLED'}`);

    try {
      await this.executeCommand('childlock', [enabled ? 'on' : 'off'], { childLock: enabled });
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  /**
   * Set light on/off.
   */
  async handleSetLightOn(value, callback) {
    this.log.info(`[SET] Light: ${value ? 'ON' : 'OFF'}`);

    try {
      let level;
      if (value) {
        // Turn on - use last known level or bright
        level = this.lastLightLevel > 0 ? this.lastLightLevel : LIGHT.BRIGHT;
      } else {
        // Turn off - save current level first
        if (this.state.lightLevel > 0) {
          this.lastLightLevel = this.state.lightLevel;
        }
        level = LIGHT.OFF;
      }

      await this.executeCommand('light', [level.toString()], { lightLevel: level });
      this.updateLightCharacteristics();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  /**
   * Set light brightness.
   */
  async handleSetLightBrightness(value, callback) {
    this.log.info(`[SET] LightBrightness: ${value}%`);

    try {
      let level;
      if (value === 0) {
        level = LIGHT.OFF;
      } else if (value <= 50) {
        level = LIGHT.DIM;
      } else {
        level = LIGHT.BRIGHT;
      }

      if (level > 0) {
        this.lastLightLevel = level;
      }

      await this.executeCommand('light', [level.toString()], { lightLevel: level });
      this.updateLightCharacteristics();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  /**
   * Update purifier characteristics in HomeKit.
   */
  updatePurifierCharacteristics() {
    this.purifierService
      .getCharacteristic(Characteristic.Active)
      .updateValue(this.getCharacteristicValue('Active'));

    this.purifierService
      .getCharacteristic(Characteristic.CurrentAirPurifierState)
      .updateValue(this.getCharacteristicValue('CurrentAirPurifierState'));

    this.purifierService
      .getCharacteristic(Characteristic.TargetAirPurifierState)
      .updateValue(this.getCharacteristicValue('TargetAirPurifierState'));

    this.purifierService
      .getCharacteristic(Characteristic.RotationSpeed)
      .updateValue(this.getCharacteristicValue('RotationSpeed'));

    this.purifierService
      .getCharacteristic(Characteristic.LockPhysicalControls)
      .updateValue(this.getCharacteristicValue('LockPhysicalControls'));
  }

  /**
   * Update light characteristics in HomeKit.
   */
  updateLightCharacteristics() {
    this.lightService
      .getCharacteristic(Characteristic.On)
      .updateValue(this.getCharacteristicValue('LightOn'));

    this.lightService
      .getCharacteristic(Characteristic.Brightness)
      .updateValue(this.getCharacteristicValue('LightBrightness'));
  }

  /**
   * Update air quality characteristics in HomeKit.
   */
  updateAirQualityCharacteristics() {
    this.airQualitySensor
      .getCharacteristic(Characteristic.AirQuality)
      .updateValue(this.getCharacteristicValue('AirQuality'));

    this.airQualitySensor
      .getCharacteristic(Characteristic.PM2_5Density)
      .updateValue(this.getCharacteristicValue('PM2_5Density'));
  }

  /**
   * Update filter characteristics in HomeKit.
   */
  updateFilterCharacteristics() {
    this.hepaFilterService
      .getCharacteristic(Characteristic.FilterLifeLevel)
      .updateValue(this.getCharacteristicValue('HEPAFilterLifeLevel'));

    this.hepaFilterService
      .getCharacteristic(Characteristic.FilterChangeIndication)
      .updateValue(this.getCharacteristicValue('HEPAFilterChangeIndication'));

    this.preFilterService
      .getCharacteristic(Characteristic.FilterLifeLevel)
      .updateValue(this.getCharacteristicValue('PreFilterLifeLevel'));

    this.preFilterService
      .getCharacteristic(Characteristic.FilterChangeIndication)
      .updateValue(this.getCharacteristicValue('PreFilterChangeIndication'));
  }

  /**
   * Update device reachability status.
   */
  updateReachabilityStatus() {
    if (!this.deviceReachable) {
      this.log.warn('Device unreachable');
    }
  }

  /**
   * Return all services for this accessory.
   */
  getServices() {
    return [
      this.informationService,
      this.purifierService,
      this.airQualitySensor,
      this.hepaFilterService,
      this.preFilterService,
      this.lightService,
    ];
  }

  /**
   * Identify the accessory.
   */
  identify(callback) {
    this.log.info(`Identify requested for ${this.name}`);
    callback(null);
  }
}
