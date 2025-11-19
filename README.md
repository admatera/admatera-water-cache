# admatera-water-cache
[![USGS Water Cache](https://github.com/admatera/admatera-water-cache/actions/workflows/usgs-water.yml/badge.svg?branch=main)](https://github.com/admatera/admatera-water-cache/actions/workflows/usgs-water.yml)
![updated](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fadmatera%2Fadmatera-water-cache%2Fmain%2Fdata%2Fhealth.json&query=%24.updatedAt&label=updated)
![sites](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fadmatera%2Fadmatera-water-cache%2Fmain%2Fdata%2Fusgs-latest.json&query=%24.count&label=sites)
Schema: data/usgs-latest.json → updatedAt (ISO), count (int), items[].site (string), items[].state (2-letter), items[].tempC (number, °C), items[].condu (µS/cm).  Health: data/health.json → { "updatedAt": "<ISO>" }.
