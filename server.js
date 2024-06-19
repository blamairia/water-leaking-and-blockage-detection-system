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
let lastFlowRate = [0, 0, 0];

let realTimeData = [{}, {}, {}];

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
});

// Load last logged values
const loadLastLoggedValues = () => {
  db.all("SELECT sensor_id, pulse_count FROM pulses ORDER BY timestamp DESC LIMIT 3", (err, rows) => {
    if (err) console.error('Error loading last pulse counts:', err.message);
    else if (rows.length) rows.forEach(row => lastPulseCount[row.sensor_id] = row.pulse_count);

    db.all("SELECT sensor_id, volume FROM volumes ORDER BY timestamp DESC LIMIT 3", (err, rows) => {
      if (err) console.error('Error loading last volumes:', err.message);
      else if (rows.length) rows.forEach(row => lastVolume[row.sensor_id] = row.volume);
    });

    db.all("SELECT sensor_id, flow_rate FROM flow_rates ORDER BY timestamp DESC LIMIT 3", (err, rows) => {
      if (err) console.error('Error loading last flow rates:', err.message);
      else if (rows.length) rows.forEach(row => lastFlowRate[row.sensor_id] = row.flow_rate);
    });
  });
};

// Initial load of last known values
loadLastLoggedValues();

// Set up serial port
const serialPort = new SerialPort({ path: 'COM24', baudRate: 9600 });
const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

parser.on('data', (data) => {
  console.log('Serial data received:', data);
  const trimmedData = data.trim();
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

        // Store real-time data
        realTimeData[sensorId] = { flowRate: parsedFlowRate, pulseCount: parsedPulseCount };

        if (parsedFlowRate > 0) {
          db.run("INSERT INTO flow_rates (sensor_id, flow_rate) VALUES (?, ?)", [sensorId, parsedFlowRate], (err) => {
            if (err) console.error('Error inserting into flow_rates table:', err.message);
            else console.log(`Flow rate logged for sensor ${sensorId + 1}: ${parsedFlowRate}`);
          });
          lastFlowRate[sensorId] = parsedFlowRate;
        }

        if (parsedPulseCount > 0) {
          const newPulseCount = parsedPulseCount + (lastPulseCount[sensorId] || 0);
          db.run("INSERT INTO pulses (sensor_id, pulse_count) VALUES (?, ?)", [sensorId, newPulseCount], (err) => {
            if (err) console.error('Error inserting into pulses table:', err.message);
            else console.log(`Pulse count logged for sensor ${sensorId + 1}: ${newPulseCount}`);
          });
          lastPulseCount[sensorId] = newPulseCount;

          const calibrationFactor = sensorId === 0 ? calibrationFactor1 : sensorId === 1 ? calibrationFactor2 : calibrationFactor3;
          const derivedVolume = newPulseCount / calibrationFactor;
          const newVolume = derivedVolume + (lastVolume[sensorId] || 0);

          db.run("INSERT INTO volumes (sensor_id, volume) VALUES (?, ?)", [sensorId, newVolume], (err) => {
            if (err) console.error('Error inserting into volumes table:', err.message);
            else console.log(`Volume logged for sensor ${sensorId + 1}: ${newVolume}`);
          });
          lastVolume[sensorId] = newVolume;

          // Calculate median values
          const medianPulseCount = (lastPulseCount[0] + lastPulseCount[1] + lastPulseCount[2]) / 3;
          db.run("INSERT INTO median_pulses (median_pulse_count) VALUES (?)", [medianPulseCount], (err) => {
            if (err) console.error('Error inserting into median_pulses table:', err.message);
            else console.log(`Median pulse count logged: ${medianPulseCount}`);
          });

          const medianFlowRate = (lastFlowRate[0] + lastFlowRate[1] + lastFlowRate[2]) / 3;
          db.run("INSERT INTO median_flow_rates (median_flow_rate) VALUES (?)", [medianFlowRate], (err) => {
            if (err) console.error('Error inserting into median_flow_rates table:', err.message);
            else console.log(`Median flow rate logged: ${medianFlowRate}`);
          });

          const medianVolume = (lastVolume[0] + lastVolume[1] + lastVolume[2]) / 3;
          db.run("INSERT INTO median_volumes (median_volume) VALUES (?)", [medianVolume], (err) => {
            if (err) console.error('Error inserting into median_volumes table:', err.message);
            else console.log(`Median volume logged: ${medianVolume}`);
          });
        }

        // Emit real-time data to the front-end
        io.emit('realtime-data', { sensorId, flowRate: parsedFlowRate, volume: lastVolume[sensorId], pulseCount: parsedPulseCount });
      } else {
        console.warn('Incomplete data received from serial:', { sensor: parts[0], sensorData });
      }
    } else {
      console.warn('Invalid data format received from serial:', line);
    }
  });
});

// Real-time data endpoints
app.get('/realtime/pulses/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  console.log(`GET /realtime/pulses/${sensorId}`);
  res.json([{ pulse_count: realTimeData[sensorId].pulseCount || 0 }]);
});

app.get('/realtime/flow_rates/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  console.log(`GET /realtime/flow_rates/${sensorId}`);
  res.json([{ flow_rate: realTimeData[sensorId].flowRate || 0 }]);
});

app.get('/realtime/volumes/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  console.log(`GET /realtime/volumes/${sensorId}`);
  const calibrationFactor = sensorId === 0 ? calibrationFactor1 : sensorId === 1 ? calibrationFactor2 : calibrationFactor3;
  const volume = (realTimeData[sensorId].pulseCount || 0) / calibrationFactor;
  res.json([{ volume: volume.toFixed(2) }]);
});

// Real-time median data endpoints
app.get('/realtime/median_pulses', (req, res) => {
  console.log('GET /realtime/median_pulses');
  const medianPulseCount = (lastPulseCount[0] + lastPulseCount[1] + lastPulseCount[2]) / 3;
  res.json([{ median_pulse_count: medianPulseCount }]);
});

app.get('/realtime/median_flow_rates', (req, res) => {
  console.log('GET /realtime/median_flow_rates');
  const medianFlowRate = (lastFlowRate[0] + lastFlowRate[1] + lastFlowRate[2]) / 3;
  res.json([{ median_flow_rate: medianFlowRate }]);
});

app.get('/realtime/median_volumes', (req, res) => {
  console.log('GET /realtime/median_volumes');
  const medianVolume = (lastVolume[0] + lastVolume[1] + lastVolume[2]) / 3;
  res.json([{ median_volume: medianVolume }]);
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
