# Homebridge Philips Air Purifier Plugin

Control your Philips Air Purifier with HomeKit via Homebridge.

## Features

- ✅ **Power On/Off** - Turn your air purifier on or off
- ✅ **4 Ventilation Modes** - Auto, Sleep, Medium, Turbo
- ✅ **Air Quality Sensor** - Real-time PM2.5 readings
- ✅ **Display Light Control** - Control brightness (Off, Dim, Bright)
- ✅ **Child Lock** - Lock/unlock physical controls
- ✅ **HomeKit Native** - Full integration with Apple Home app
- ✅ **Real-time Updates** - Uses CoAP Observe for push updates from device

## Prerequisites

1. **Homebridge** installed and running
2. **Python 3** with `aioairctrl` package installed
3. Your Philips Air Purifier's **IP address**

## Installation

### Step 1: Install Python Dependencies

```bash
# Install aioairctrl (system-wide or in a virtual environment)
pip3 install aioairctrl

# Or using a virtual environment (recommended)
python3 -m venv ~/philips-air-venv
source ~/philips-air-venv/bin/activate
pip install aioairctrl
```

### Step 2: Preflight Check (connectivity)

Test connectivity to your device:

```bash
python3 <plugin-dir>/philips_air_api.py <device-ip> sensors
```

You should see a JSON payload with sensor readings. If you get transient errors, re-run; CoAP can be flaky on first connection.

### Step 3: Install Homebridge Plugin

```bash
# Install via npm
npm install -g @louis.crc/homebridge-philips-air-purifier

# Or install via Homebridge UI:
# Plugins → Search "@louis.crc/homebridge-philips-air-purifier" → Install
```

### Step 4: Configure Homebridge

Add to your `config.json`:

```json
{
  "accessories": [
    {
      "accessory": "PhilipsAirPurifier",
      "name": "Air Purifier",
      "host": "192.168.1.100"
    }
  ]
}
```

**Configuration Options:**

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `name` | Yes | - | Name shown in HomeKit |
| `host` | Yes | - | IP address of your air purifier |
| `pythonPath` | No | Auto-detected | Path to Python 3 with `aioairctrl` |
| `apiScriptPath` | No | Auto-detected | Path to `philips_air_api.py` |

### Step 5: Restart Homebridge

```bash
sudo systemctl restart homebridge
# or use Homebridge UI to restart
```

## Usage

Once configured, you'll see your air purifier in the Apple Home app with:

1. **Air Purifier** - Power on/off, Auto/Manual mode, rotation speed
2. **Air Quality Sensor** - PM2.5 density and derived quality rating
3. **Display Light** - Toggle and brightness (Off/Dim/Bright)
4. **Child Lock** - Lock physical controls on the device

## Architecture

This plugin uses a Python daemon with **CoAP Observe** for efficient communication:

- **Push updates**: Device pushes state changes (~every 30s or on change)
- **Fast commands**: Power, mode, light commands complete in ~100-300ms
- **No polling delays**: State reads are instant from cached data

## CLI Tool

The bundled Python script can also be used standalone:

```bash
# Get sensor readings
python3 philips_air_api.py 192.168.1.100 sensors

# Control power
python3 philips_air_api.py 192.168.1.100 power on
python3 philips_air_api.py 192.168.1.100 power off

# Set mode
python3 philips_air_api.py 192.168.1.100 mode auto
python3 philips_air_api.py 192.168.1.100 mode sleep
python3 philips_air_api.py 192.168.1.100 mode medium
python3 philips_air_api.py 192.168.1.100 mode turbo

# Control light (0=off, 115=dim, 123=bright)
python3 philips_air_api.py 192.168.1.100 light 0
python3 philips_air_api.py 192.168.1.100 light 123

# Child lock
python3 philips_air_api.py 192.168.1.100 childlock on
python3 philips_air_api.py 192.168.1.100 childlock off
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Credits

**Author:** [louiscrc](https://github.com/louiscrc)

Built using:

- [aioairctrl](https://github.com/betaboon/aioairctrl) - Python library for Philips Air devices
- [Homebridge](https://homebridge.io/) - HomeKit support for non-Apple devices

## Support

- **Issues:** [GitHub Issues](https://github.com/louiscrc/homebridge-philips-air-purifier/issues)
- **npm Package:** [@louis.crc/homebridge-philips-air-purifier](https://www.npmjs.com/package/@louis.crc/homebridge-philips-air-purifier)
