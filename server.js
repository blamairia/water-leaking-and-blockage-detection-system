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
const calibrationFactor1 = 8784.5 / 17.22;
const calibrationFactor2 = 8846.25 / 17.22;
const calibrationFactor3 = 10413.75 / 17.22;

// Store the last logged values and real-time values
let lastPulseCount = [0, 0, 0];
let lastVolume = [0, 0, 0];
let realTimeData = [{ flowRate: 0, pulseCount: 0, volume: 0 }, { flowRate: 0, pulseCount: 0, volume: 0 }, { flowRate: 0, pulseCount: 0, volume: 0 }];
let medianRealTimeData = { flowRate: 0, pulseCount: 0, volume: 0 };
let latestSystemState = 'UNKNOWN';

// Open the database
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS pulses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, sensor_id INTEGER, pulse_count INTEGER)", (err) => {
    if (err) console.error('Error creating pulses table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS flow_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, sensor_id INTEGER, flow_rate REAL)", (err) => {
    if (err) console.error('Error creating flow_rates table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS volumes (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, sensor_id INTEGER, volume REAL)", (err) => {
    if (err) console.error('Error creating volumes table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS median_pulses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, median_pulse_count INTEGER)", (err) => {
    if (err) console.error('Error creating median_pulses table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS median_flow_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, median_flow_rate REAL)", (err) => {
    if (err) console.error('Error creating median_flow_rates table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS median_volumes (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, median_volume REAL)", (err) => {
    if (err) console.error('Error creating median_volumes table:', err.message);
  });
  db.run("CREATE TABLE IF NOT EXISTS system_state (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, state TEXT)", (err) => {
    if (err) console.error('Error creating system_state table:', err.message);
  });
});

// Set up serial port
const serialPort = new SerialPort({ path: 'COM24', baudRate: 9600 });
const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

parser.on('data', (data) => {
  console.log('Serial data received:', data);
  const trimmedData = data.trim();

  if (trimmedData === 'ON' || trimmedData === 'OFF') {
    latestSystemState = trimmedData;
    // Log the system state change to the database
    db.run("INSERT INTO system_state (state) VALUES (?)", [trimmedData], (err) => {
      if (err) console.error('Error inserting into system_state table:', err.message);
      else console.log(`System state logged: ${trimmedData}`);
    });
  } else {
    const lines = trimmedData.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length === 2) {
        const sensorData = parts[1].split(',');
        if (sensorData.length === 3) {
          const [flowRate, , pulseCount] = sensorData;
          const sensorId = parseInt(parts[0].replace('FlowMeter', '')) - 1;
          const parsedFlowRate = parseFloat(flowRate);
          const parsedPulseCount = parseInt(pulseCount);

          // Calculate volume from pulse count
          let volume = 0;
          switch (sensorId) {
            case 0:
              volume = parsedPulseCount / calibrationFactor1;
              break;
            case 1:
              volume = parsedPulseCount / calibrationFactor2;
              break;
            case 2:
              volume = parsedPulseCount / calibrationFactor3;
              break;
          }

          // Update real-time data
          realTimeData[sensorId] = {
            flowRate: parsedFlowRate,
            pulseCount: parsedPulseCount,
            volume: volume
          };

          // Only log non-zero values into the database
          if (parsedFlowRate !== 0) {
            db.run("INSERT INTO flow_rates (sensor_id, flow_rate) VALUES (?, ?)", [sensorId, parsedFlowRate], (err) => {
              if (err) console.error('Error inserting into flow_rates table:', err.message);
              else console.log(`Flow rate logged for sensor ${sensorId + 1}: ${parsedFlowRate}`);
            });
          }

          if (parsedPulseCount !== 0) {
            db.get("SELECT pulse_count FROM pulses WHERE sensor_id = ? ORDER BY timestamp DESC LIMIT 1", [sensorId], (err, row) => {
              if (err) {
                console.error('Error fetching last pulse count:', err.message);
                return;
              }

              const lastPulse = row ? row.pulse_count : 0;
              const newPulseCount = lastPulse + parsedPulseCount;

              db.run("INSERT INTO pulses (sensor_id, pulse_count) VALUES (?, ?)", [sensorId, newPulseCount], (err) => {
                if (err) console.error('Error inserting into pulses table:', err.message);
                else console.log(`Pulse count logged for sensor ${sensorId + 1}: ${newPulseCount}`);
              });

              db.get("SELECT volume FROM volumes WHERE sensor_id = ? ORDER BY timestamp DESC LIMIT 1", [sensorId], (err, row) => {
                if (err) {
                  console.error('Error fetching last volume:', err.message);
                  return;
                }

                const lastVolume = row ? row.volume : 0;
                const newVolume = lastVolume + volume;

                db.run("INSERT INTO volumes (sensor_id, volume) VALUES (?, ?)", [sensorId, newVolume], (err) => {
                  if (err) console.error('Error inserting into volumes table:', err.message);
                  else console.log(`Volume logged for sensor ${sensorId + 1}: ${newVolume}`);
                });
              });
            });
          }

          // Update median values if any value changes
          if (parsedFlowRate !== 0 || parsedPulseCount !== 0) {
            db.all("SELECT pulse_count FROM pulses WHERE timestamp >= datetime('now', '-1 second')", (err, rows) => {
              if (!err && rows.length === 3) {
                const pulses = rows.map(row => row.pulse_count).sort((a, b) => a - b);
                const medianPulseCount = pulses[1];
                db.run("INSERT INTO median_pulses (median_pulse_count) VALUES (?)", [medianPulseCount], (err) => {
                  if (err) console.error('Error inserting into median_pulses table:', err.message);
                  else console.log(`Median pulse count logged: ${medianPulseCount}`);
                });
              } else {
                if (err) console.error('Error fetching pulse counts for median calculation:', err.message);
              }
            });

            db.all("SELECT flow_rate FROM flow_rates WHERE timestamp >= datetime('now', '-1 second')", (err, rows) => {
              if (!err && rows.length === 3) {
                const flowRates = rows.map(row => row.flow_rate).sort((a, b) => a - b);
                const medianFlowRate = flowRates[1];
                db.run("INSERT INTO median_flow_rates (median_flow_rate) VALUES (?)", [medianFlowRate], (err) => {
                  if (err) console.error('Error inserting into median_flow_rates table:', err.message);
                  else console.log(`Median flow rate logged: ${medianFlowRate}`);
                });
              } else {
                if (err) console.error('Error fetching flow rates for median calculation:', err.message);
              }
            });

            db.all("SELECT volume FROM volumes WHERE timestamp >= datetime('now', '-1 second')", (err, rows) => {
              if (!err && rows.length === 3) {
                const volumes = rows.map(row => row.volume).sort((a, b) => a - b);
                const medianVolume = volumes[1];
                db.run("INSERT INTO median_volumes (median_volume) VALUES (?)", [medianVolume], (err) => {
                  if (err) console.error('Error inserting into median_volumes table:', err.message);
                  else console.log(`Median volume logged: ${medianVolume}`);
                });
              } else {
                if (err) console.error('Error fetching volumes for median calculation:', err.message);
              }
            });
          }

          // Calculate median real-time data
          const totalFlowRate = realTimeData.reduce((acc, data) => acc + data.flowRate, 0);
          const totalPulseCount = realTimeData.reduce((acc, data) => acc + data.pulseCount, 0);
          const totalVolume = realTimeData.reduce((acc, data) => acc + data.volume, 0);

          medianRealTimeData = {
            flowRate: totalFlowRate / 3,
            pulseCount: totalPulseCount / 3,
            volume: totalPulseCount / (3 * 9348 / 17.22)
          };

          // Emit real-time data to the front-end
          io.emit('realtime-data', { sensorId, flowRate: parsedFlowRate, volume, pulseCount: parsedPulseCount });
          io.emit('realtime-median-data', medianRealTimeData);
        } else {
          console.warn('Incomplete data received from serial:', { sensor: parts[0], sensorData });
        }
      } else {
        console.warn('Invalid data format received from serial:', line);
      }
    });
  }
});

// Endpoint to switch system state
app.post('/system/switch', (req, res) => {
  serialPort.write('P');
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
    const volume = realTimeData[sensorId].pulseCount / calibrationFactor1;
    res.json([{ volume }]);
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

// Historical data endpoints with date filtering
app.get('/history/pulses/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  const date = req.query.date;
  console.log(`GET /history/pulses/${sensorId}?date=${date}`);
  db.all("SELECT * FROM pulses WHERE sensor_id = ? AND DATE(timestamp) = ?", [sensorId, date], (err, rows) => {
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
  const date = req.query.date;
  console.log(`GET /history/flow_rates/${sensorId}?date=${date}`);
  db.all("SELECT * FROM flow_rates WHERE sensor_id = ? AND DATE(timestamp) = ?", [sensorId, date], (err, rows) => {
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
  const date = req.query.date;
  console.log(`GET /history/volumes/${sensorId}?date=${date}`);
  db.all("SELECT * FROM volumes WHERE sensor_id = ? AND DATE(timestamp) = ?", [sensorId, date], (err, rows) => {
    if (err) {
      console.error('Error fetching from volumes table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Historical median data endpoints with date filtering
app.get('/history/median_pulses', (req, res) => {
  const date = req.query.date;
  console.log(`GET /history/median_pulses?date=${date}`);
  db.all("SELECT * FROM median_pulses WHERE DATE(timestamp) = ?", [date], (err, rows) => {
    if (err) {
      console.error('Error fetching from median_pulses table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/median_flow_rates', (req, res) => {
  const date = req.query.date;
  console.log(`GET /history/median_flow_rates?date=${date}`);
  db.all("SELECT * FROM median_flow_rates WHERE DATE(timestamp) = ?", [date], (err, rows) => {
    if (err) {
      console.error('Error fetching from median_flow_rates table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/median_volumes', (req, res) => {
  const date = req.query.date;
  console.log(`GET /history/median_volumes?date=${date}`);
  db.all("SELECT * FROM median_volumes WHERE DATE(timestamp) = ?", [date], (err, rows) => {
    if (err) {
      console.error('Error fetching from median_volumes table:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Start server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
