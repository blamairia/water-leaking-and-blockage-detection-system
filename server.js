const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;
const db = new sqlite3.Database('./flowMeterData.db');

// Serve static files from the "client" directory
app.use(express.static(path.join(__dirname, 'client')));

// Calibration factors
const calibrationFactors = [342.5, 314, 438.5];

// Store the last logged values and real-time values
let lastPulseCount = [0, 0, 0];
let lastFlowRate = [0, 0, 0];
let lastVolume = [0, 0, 0];
let realTimeData = [
  { pulseCount: 0, flowRate: 0, volume: 0 },
  { pulseCount: 0, flowRate: 0, volume: 0 },
  { pulseCount: 0, flowRate: 0, volume: 0 }
];
let medianRealTimeData = { pulseCount: 0, flowRate: 0, volume: 0 };
let latestSystemState = 'UNKNOWN';
let blockageDetected = false;
let blockageStartTime = null;
let leakDetected = false;
let leakStartTime = null;
const blockageDetectionDelay = 5000; // 5 seconds
const leakDetectionDelay = 3000; // 3 seconds
const flowRateTolerance = 0.1; // Adjust tolerance as needed

// Open the database
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS pulses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, sensor_id INTEGER, pulse_count INTEGER)", err => {
    if (err) console.error('Error creating pulses table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS flow_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, sensor_id INTEGER, flow_rate REAL)", err => {
    if (err) console.error('Error creating flow_rates table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS volumes (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, sensor_id INTEGER, volume REAL)", err => {
    if (err) console.error('Error creating volumes table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS median_pulses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, median_pulse_count INTEGER)", err => {
    if (err) console.error('Error creating median_pulses table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS median_flow_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, median_flow_rate REAL)", err => {
    if (err) console.error('Error creating median_flow_rates table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS median_volumes (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, median_volume REAL)", err => {
    if (err) console.error('Error creating median_volumes table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS system_state (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, state TEXT)", err => {
    if (err) console.error('Error creating system_state table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, error_type TEXT, details TEXT)", err => {
    if (err) console.error('Error creating error_log table:', err.message);
  });
});

// Set up serial port
const serialPort = new SerialPort({ path: 'COM15', baudRate: 115200 });
const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

parser.on('data', data => {
  console.log('Serial data received:', data);
  const trimmedData = data.trim();

  if (trimmedData === 'ON' || trimmedData === 'OFF') {
    latestSystemState = trimmedData;
    // Log the system state change to the database
    db.run("INSERT INTO system_state (state) VALUES (?)", [trimmedData], err => {
      if (err) console.error('Error inserting into system_state table:', err.message);
      else console.log(`System state logged: ${trimmedData}`);
    });
  } else {
    const lines = trimmedData.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length === 2) {
        const pulseCount = parseInt(parts[1]);
        const sensorId = parseInt(parts[0].replace('FlowMeter', '')) - 1;

        // Calculate pulses per second (assuming data received every second)
        const pulsesPerSecond = pulseCount;

        // Calculate flow rate (liters/minute)
        const flowRate = (pulsesPerSecond / calibrationFactors[sensorId]) * 60;

        // Calculate volume (liters)
        const volume = pulseCount / calibrationFactors[sensorId];

        // Fetch the last logged volume for the sensor
        db.get("SELECT volume FROM volumes WHERE sensor_id = ? ORDER BY timestamp DESC LIMIT 1", [sensorId], (err, row) => {
          if (err) {
            console.error('Error fetching last volume from volumes table:', err.message);
          } else {
            const lastLoggedVolume = row ? row.volume : 0;
            const accumulatedVolume = lastLoggedVolume + volume;

            // Update real-time data
            realTimeData[sensorId] = {
              pulseCount: pulseCount,
              flowRate: flowRate,
              volume: accumulatedVolume
            };

            // Calculate median real-time data
            const totalFlowRate = realTimeData.reduce((acc, data) => acc + data.flowRate, 0);
            const totalPulseCount = realTimeData.reduce((acc, data) => acc + data.pulseCount, 0);
            const totalVolume = realTimeData.reduce((acc, data) => acc + data.volume, 0);

            medianRealTimeData = {
              flowRate: totalFlowRate / 3,
              pulseCount: totalPulseCount / 3,
              volume: totalVolume / 3
            };

            // Emit real-time data to the front-end
            io.emit('realtime-data', { sensorId, pulseCount: pulseCount, flowRate: flowRate, volume: accumulatedVolume });
            io.emit('realtime-median-data', medianRealTimeData);

            // Log pulse count into the database if changed
            if (lastPulseCount[sensorId] !== pulseCount) {
              db.run("INSERT INTO pulses (sensor_id, pulse_count) VALUES (?, ?)", [sensorId, pulseCount], err => {
                if (err) console.error('Error inserting into pulses table:', err.message);
                else console.log(`Pulse count logged for sensor ${sensorId + 1}: ${pulseCount}`);
              });
              lastPulseCount[sensorId] = pulseCount;
            }

            // Log flow rate into the database if changed
            if (lastFlowRate[sensorId] !== flowRate) {
              db.run("INSERT INTO flow_rates (sensor_id, flow_rate) VALUES (?, ?)", [sensorId, flowRate], err => {
                if (err) console.error('Error inserting into flow_rates table:', err.message);
                else console.log(`Flow rate logged for sensor ${sensorId + 1}: ${flowRate}`);
              });
              lastFlowRate[sensorId] = flowRate;
            }

            // Log volume into the database if changed
            if (lastVolume[sensorId] !== volume) {
              db.run("INSERT INTO volumes (sensor_id, volume) VALUES (?, ?)", [sensorId, accumulatedVolume], err => {
                if (err) console.error('Error inserting into volumes table:', err.message);
                else console.log(`Volume logged for sensor ${sensorId + 1}: ${accumulatedVolume}`);
              });
              lastVolume[sensorId] = accumulatedVolume;
            }

            // Log median values
            db.run("INSERT INTO median_pulses (median_pulse_count) VALUES (?)", [medianRealTimeData.pulseCount], err => {
              if (err) console.error('Error inserting into median_pulses table:', err.message);
              else console.log('Median pulse count logged:', medianRealTimeData.pulseCount);
            });
            db.run("INSERT INTO median_flow_rates (median_flow_rate) VALUES (?)", [medianRealTimeData.flowRate], err => {
              if (err) console.error('Error inserting into median_flow_rates table:', err.message);
              else console.log('Median flow rate logged:', medianRealTimeData.flowRate);
            });
            db.run("INSERT INTO median_volumes (median_volume) VALUES (?)", [medianRealTimeData.volume], err => {
              if (err) console.error('Error inserting into median_volumes table:', err.message);
              else console.log('Median volume logged:', medianRealTimeData.volume);
            });

            // Detect blockage using flow rate as indicator
            if (latestSystemState === 'ON' && sensorId === 2 && flowRate <= flowRateTolerance) {
              if (!blockageStartTime) {
                blockageStartTime = Date.now();
              } else if (Date.now() - blockageStartTime >= blockageDetectionDelay) {
                blockageDetected = true;
                serialPort.write('P'); // Switch off the system
                db.run("INSERT INTO error_log (error_type, details) VALUES (?, ?)", ['Blockage Detected', 'Blockage detected between Sensor 2 and Sensor 3.'], err => {
                  if (err) console.error('Error inserting into error_log table:', err.message);
                  else console.log('Blockage detected and logged.');
                });
                blockageStartTime = null;
              }
            } else if (sensorId === 2 && flowRate > flowRateTolerance) {
              blockageStartTime = null;
            }

            // Detect leak using flow rate and a threshold
            if (latestSystemState === 'ON') {
              const flowRateDiff1 = Math.abs(realTimeData[0].flowRate - realTimeData[1].flowRate);
              const flowRateDiff2 = Math.abs(realTimeData[1].flowRate - realTimeData[2].flowRate);
              const tolerance1 = 0.5 * realTimeData[0].flowRate; // 50% tolerance for the first difference
              const tolerance2 = 0.5 * realTimeData[1].flowRate; // 50% tolerance for the second difference

              if ((flowRateDiff1 > tolerance1) || (flowRateDiff2 > tolerance2)) {
                if (!leakStartTime) {
                  leakStartTime = Date.now();
                } else if (Date.now() - leakStartTime >= leakDetectionDelay) {
                  leakDetected = true;
                  serialPort.write('P'); // Switch off the system
                  db.run("INSERT INTO error_log (error_type, details) VALUES (?, ?)", ['Leak Detected', 'Leak detected between sensors.'], err => {
                    if (err) console.error('Error inserting into error_log table:', err.message);
                    else console.log('Leak detected and logged.');
                  });
                  leakStartTime = null;
                }
              } else {
                leakStartTime = null;
              }
            }
          }
        });
      } else {
        console.warn('Invalid data format received from serial:', line);
      }
    });
  }
});

// Endpoint to switch system state
app.post('/system/switch', (req, res) => {
  serialPort.write('P');
  leakDetected = false; // Reset leak state
  blockageDetected = false; // Reset blockage state
  res.json({ message: 'System state switched' });
});

// Endpoint to get current system state
app.get('/system/state', (req, res) => {
  serialPort.write('S');
  setTimeout(() => {
    res.json({ state: latestSystemState });
  }, 1000); // Wait 1 second to give Arduino time to respond
});

// Real-time data endpoints
app.get('/realtime/pulses/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  console.log(`GET /realtime/pulses/${sensorId}`);
  if (realTimeData[sensorId]) {
    res.json([{ pulse_count: realTimeData[sensorId].pulseCount }]);
  } else {
    res.status(500).json({ error: 'No real-time data available' });
  }
});

app.get('/realtime/flow_rates/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  console.log(`GET /realtime/flow_rates/${sensorId}`);
  if (realTimeData[sensorId]) {
    res.json([{ flow_rate: realTimeData[sensorId].flowRate }]);
  } else {
    res.status(500).json({ error: 'No real-time data available' });
  }
});

app.get('/realtime/volumes/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  console.log(`GET /realtime/volumes/${sensorId}`);
  if (realTimeData[sensorId]) {
    res.json([{ volume: realTimeData[sensorId].volume }]);
  } else {
    res.status(500).json({ error: 'No real-time data available' });
  }
});

// Real-time median data endpoints
app.get('/realtime/median_pulses', (req, res) => {
  console.log('GET /realtime/median_pulses');
  res.json([{ pulse_count: medianRealTimeData.pulseCount }]);
});

app.get('/realtime/median_flow_rates', (req, res) => {
  console.log('GET /realtime/median_flow_rates');
  res.json([{ flow_rate: medianRealTimeData.flowRate }]);
});

app.get('/realtime/median_volumes', (req, res) => {
  console.log('GET /realtime/median_volumes');
  res.json([{ volume: medianRealTimeData.volume }]);
});

// Historical data endpoints with date range filtering
app.get('/history/pulses/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  console.log(`GET /history/pulses/${sensorId}?start_date=${startDate}&end_date=${endDate}`);
  db.all("SELECT * FROM pulses WHERE sensor_id = ? AND DATE(timestamp) BETWEEN ? AND ?", [sensorId, startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching from pulses table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/flow_rates/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  console.log(`GET /history/flow_rates/${sensorId}?start_date=${startDate}&end_date=${endDate}`);
  db.all("SELECT * FROM flow_rates WHERE sensor_id = ? AND DATE(timestamp) BETWEEN ? AND ?", [sensorId, startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching from flow_rates table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/volumes/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  console.log(`GET /history/volumes/${sensorId}?start_date=${startDate}&end_date=${endDate}`);
  db.all("SELECT * FROM volumes WHERE sensor_id = ? AND DATE(timestamp) BETWEEN ? AND ?", [sensorId, startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching from volumes table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Historical median data endpoints with date range filtering
app.get('/history/median_pulses', (req, res) => {
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  console.log(`GET /history/median_pulses?start_date=${startDate}&end_date=${endDate}`);
  db.all("SELECT * FROM median_pulses WHERE DATE(timestamp) BETWEEN ? AND ?", [startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching from median_pulses table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/median_flow_rates', (req, res) => {
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  console.log(`GET /history/median_flow_rates?start_date=${startDate}&end_date=${endDate}`);
  db.all("SELECT * FROM median_flow_rates WHERE DATE(timestamp) BETWEEN ? AND ?", [startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching from median_flow_rates table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/median_volumes', (req, res) => {
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  console.log(`GET /history/median_volumes?start_date=${startDate}&end_date=${endDate}`);
  db.all("SELECT * FROM median_volumes WHERE DATE(timestamp) BETWEEN ? AND ?", [startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching from median_volumes table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Error log endpoint
app.get('/errors', (req, res) => {
  console.log('GET /errors');
  db.all("SELECT * FROM error_log", (err, rows) => {
    if (err) {
      console.error('Error fetching from error_log table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Endpoint to get leakDetected and blockageDetected status
app.get('/detection_status', (req, res) => {
  console.log('GET /detection_status');
  res.json({ leakDetected, blockageDetected });
});

// Start server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
