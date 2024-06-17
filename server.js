const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CORS configuration
app.use(cors({
  origin: '*', // Update with your frontend origin
  methods: ['GET', 'POST']
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serial port configuration
const port = new SerialPort({ path: 'COM24', baudRate: 9600 });
const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

// Connect to SQLite database
let db = new sqlite3.Database('flowData.db', (err) => {
  if (err) {
    return console.error('Error connecting to SQLite database:', err.message);
  }
  console.log('Connected to the SQLite database.');
});

// Create tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS flowRates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME,
            flowRate1 REAL,
            flowRate2 REAL,
            flowRate3 REAL,
            totalVolume REAL
        )`, (err) => {
    if (err) {
      return console.error('Error creating flowRates table:', err.message);
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS totalVolume (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME,
            totalVolume REAL
        )`, (err) => {
    if (err) {
      return console.error('Error creating totalVolume table:', err.message);
    }
  });

  ['flowMeter1', 'flowMeter2', 'flowMeter3'].forEach(table => {
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              timestamp DATETIME,
              flowRate REAL,
              totalVolume REAL,
              pulses INTEGER
          )`, (err) => {
      if (err) {
        return console.error(`Error creating ${table} table:`, err.message);
      }
    });
  });
});

let lastLoggedVolume = 0;

// Function to log flow rates
function logFlowRates(flowRate1, flowRate2, flowRate3, totalVolume) {
  const timestamp = new Date().toISOString();
  if (Math.abs(totalVolume - lastLoggedVolume) >= 0.2) {
    db.run(`INSERT INTO flowRates (timestamp, flowRate1, flowRate2, flowRate3, totalVolume)
            VALUES (?, ?, ?, ?, ?)`, [timestamp, flowRate1, flowRate2, flowRate3, totalVolume], function (err) {
      if (err) {
        return console.error('Error logging flow rates:', err.message);
      }
      console.log(`Flow rates saved: ${timestamp}, ${flowRate1}, ${flowRate2}, ${flowRate3}, ${totalVolume}`);
      io.emit('newData', { timestamp, flowRate1, flowRate2, flowRate3, totalVolume });
    });
    lastLoggedVolume = totalVolume;
  }
}

// Function to log total volume
function logTotalVolume(totalVolume) {
  const timestamp = new Date().toISOString();
  if (Math.abs(totalVolume - lastLoggedVolume) >= 0.2) {
    db.run(`INSERT INTO totalVolume (timestamp, totalVolume)
            VALUES (?, ?)`, [timestamp, totalVolume], function (err) {
      if (err) {
        return console.error('Error logging total volume:', err.message);
      }
      console.log(`Total volume saved: ${timestamp}, ${totalVolume}`);
      io.emit('newTotalVolume', { timestamp, totalVolume });
    });
    lastLoggedVolume = totalVolume;
  }
}

// Function to log individual flow meter data
function logFlowMeterData(table, flowRate, totalVolume, pulses) {
  const timestamp = new Date().toISOString();
  if (Math.abs(totalVolume - lastLoggedVolume) >= 0.2) {
    db.run(`INSERT INTO ${table} (timestamp, flowRate, totalVolume, pulses)
            VALUES (?, ?, ?, ?)`, [timestamp, flowRate, totalVolume, pulses], function (err) {
      if (err) {
        return console.error(`Error logging data to ${table}:`, err.message);
      }
      console.log(`${table} data saved: ${timestamp}, ${flowRate}, ${totalVolume}, ${pulses}`);
      io.emit('newFlowMeterData', { table, timestamp, flowRate, totalVolume, pulses });
    });
    lastLoggedVolume = totalVolume;
  }
}

// Function to calculate the median volume
function calculateMedianVolume(volumes) {
  volumes.sort((a, b) => a - b);
  return volumes[1]; // Return the middle value
}

// Listen for data on the serial port
let flowRate1, volume1, pulses1;
let flowRate2, volume2, pulses2;
let flowRate3, volume3, pulses3;

parser.on('data', (line) => {
  console.log(`Received line: ${line}`);
  try {
    if (line.startsWith('FlowMeter1:')) {
      const parts = line.split(':')[1].split(',');
      if (parts.length === 3) {
        [flowRate1, volume1, pulses1] = parts.map(Number);
        logFlowMeterData('flowMeter1', flowRate1, volume1, pulses1);
        console.log(`FlowMeter1 data - FlowRate: ${flowRate1}, Volume: ${volume1}, Pulses: ${pulses1}`);
      } else {
        console.error(`Unexpected number of values for FlowMeter1: ${parts}`);
      }
    } else if (line.startsWith('FlowMeter2:')) {
      const parts = line.split(':')[1].split(',');
      if (parts.length === 3) {
        [flowRate2, volume2, pulses2] = parts.map(Number);
        logFlowMeterData('flowMeter2', flowRate2, volume2, pulses2);
        console.log(`FlowMeter2 data - FlowRate: ${flowRate2}, Volume: ${volume2}, Pulses: ${pulses2}`);
      } else {
        console.error(`Unexpected number of values for FlowMeter2: ${parts}`);
      }
    } else if (line.startsWith('FlowMeter3:')) {
      const parts = line.split(':')[1].split(',');
      if (parts.length === 3) {
        [flowRate3, volume3, pulses3] = parts.map(Number);
        logFlowMeterData('flowMeter3', flowRate3, volume3, pulses3);
        console.log(`FlowMeter3 data - FlowRate: ${flowRate3}, Volume: ${volume3}, Pulses: ${pulses3}`);

        // Calculate the total volume as the median of the three volumes
        const totalVolume = calculateMedianVolume([volume1, volume2, volume3]);
        logFlowRates(flowRate1, flowRate2, flowRate3, totalVolume);
        console.log(`Calculated total volume: ${totalVolume}`);
      } else {
        console.error(`Unexpected number of values for FlowMeter3: ${parts}`);
      }
    } else if (line.startsWith('TotalVolume:')) {
      const parts = line.split(':')[1];
      const totalVolume = parseFloat(parts);
      logTotalVolume(totalVolume);
      console.log(`Total volume: ${totalVolume}`);
    } else {
      console.error(`Unknown line format: ${line}`);
    }
  } catch (error) {
    console.error(`Error processing line: ${error.message}, line: ${line}`);
  }
});

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint for fetching data based on date
app.get('/fetch_data', (req, res) => {
  const date = req.query.date;
  const startDate = new Date(date).toISOString().split('T')[0] + 'T00:00:00.000Z';
  const endDate = new Date(date).toISOString().split('T')[0] + 'T23:59:59.999Z';

  db.all(`SELECT * FROM flowRates WHERE timestamp BETWEEN ? AND ?`, [startDate, endDate], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ data: rows });
  });
});

// API endpoints for fetching individual flow meter data
app.get('/fetch_flowMeter1_data', (req, res) => {
  const date = req.query.date;
  const startDate = new Date(date).toISOString().split('T')[0] + 'T00:00:00.000Z';
  const endDate = new Date(date).toISOString().split('T')[0] + 'T23:59:59.999Z';

  db.all(`SELECT * FROM flowMeter1 WHERE timestamp BETWEEN ? AND ?`, [startDate, endDate], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ data: rows });
  });
});

app.get('/fetch_flowMeter2_data', (req, res) => {
  const date = req.query.date;
  const startDate = new Date(date).toISOString().split('T')[0] + 'T00:00:00.000Z';
  const endDate = new Date(date).toISOString().split('T')[0] + 'T23:59:59.999Z';

  db.all(`SELECT * FROM flowMeter2 WHERE timestamp BETWEEN ? AND ?`, [startDate, endDate], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ data: rows });
  });
});

app.get('/fetch_flowMeter3_data', (req, res) => {
  const date = req.query.date;
  const startDate = new Date(date).toISOString().split('T')[0] + 'T00:00:00.000Z';
  const endDate = new Date(date).toISOString().split('T')[0] + 'T23:59:59.999Z';

  db.all(`SELECT * FROM flowMeter3 WHERE timestamp BETWEEN ? AND ?`, [startDate, endDate], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ data: rows });
  });
});

// Serial port error handling
port.on('error', (err) => {
  console.error('Error on serial port:', err.message);
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
