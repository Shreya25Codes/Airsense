# AirSense – Adaptive Fan Control Using Temperature and Humidity

**atomQUEST 2026 · Round 2 · Track 1: Fan**
Team Code Crafters, Graphic Era Deemed to be University

AirSense is a low-cost controller idea that chooses a fan level from room
temperature and relative humidity. This repository holds the **software-only
prototype**: a browser dashboard that simulates a sensor and shows how AirSense
decides, stays stable, and fails safely.

**Live demo:** [add your Netlify or GitHub Pages link here]

## What it does

- Picks a fan level from 1 to 5 using temperature bands, plus one extra level when humidity is 70% or higher.
- **Hysteresis (breathing room):** the level doesn't flip back and forth near a boundary.
- **Sensor filter:** uses the middle of the last 5 readings, so one wild reading can't move the fan.
- **Fail-safe:** if the sensor goes quiet or freezes, it keeps the last level briefly, then switches to a steady safe level and says so on screen.
- **Manual override:** you can pick a level yourself, and the dashboard always shows who is in control.
- **Try breaking the sensor:** switch on noisy readings, random spikes or a frozen sensor and watch how AirSense copes.
- **24-hour replay:** plays a made-up hot summer day or humid monsoon day and shows how steady the fan stays.
- **Live chart, event log and CSV download.**
- **Built-in self-checks:** quick checks, a 100-case test and a 2-minute steadiness test.

## How to run it

No installation needed.

1. Download or clone this repository.
2. Open `index.html` in a browser.

## Files

| File | What it is |
|------|------------|
| `index.html` | The dashboard layout |
| `style.css` | Colours, layout, dark mode and phone layout |
| `script.js` | The decision rules, simulated sensor, chart, replay and tests |

## Test results (software logic only)

These come from the built-in self-checks on the simulated data:

- Quick checks: 28 of 28 passed
- 100-case test: 100 of 100 correct
- Steadiness test: 1 level change with hysteresis vs 10 without

## Honest limits

- Everything here is **simulated**. No real sensor or fan is connected yet.
- It recommends a fan level; it does **not** control a real fan.
- Sensor accuracy, real response time, energy savings and comfort improvements have **not** been measured.
- The temperature and humidity limits are starting values for testing, not proven settings.
- The replay days are made-up data, not measurements.

## Next steps

- Connect an ESP32 with a DHT22 sensor in place of the simulated readings.
- Test with a low-voltage DC fan and a suitable driver.
- Measure sensor accuracy and response time on real hardware before making any performance claims.

## Team

Code Crafters: [add names if you want them public]
