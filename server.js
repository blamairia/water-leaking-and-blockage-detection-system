const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Demo mode configuration
const DEMO_MODE = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
console.log(`[WLeaks] Starting in ${DEMO_MODE ? 'DEMO' : 'HARDWARE'} mode`);

// Conditional imports for hardware mode
let SerialPort, ReadlineParser, serialPort, parser;
let DemoSimulator, demoSimulator;

if (DEMO_MODE) {
  DemoSimulator = require('./demoSimulator');
  demoSimulator = new DemoSimulator();
} else {
  ({ SerialPort } = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;
const db = new sqlite3.Database('./flowMeterData.db');

// Enable JSON body parsing for POST requests
app.use(express.json());

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

// ============================================
// Data processing function (shared between modes)
// ============================================
function processSensorData(sensorId, pulseCount, flowRate, volume) {
  // Fetch the last logged volume for the sensor
  db.get("SELECT volume FROM volumes WHERE sensor_id = ? ORDER BY timestamp DESC LIMIT 1", [sensorId], (err, row) => {
    if (err) {
      console.error('Error fetching last volume from volumes table:', err.message);
      return;
    }

    const lastLoggedVolume = row ? row.volume : 0;
    const accumulatedVolume = volume !== undefined ? volume : lastLoggedVolume + (pulseCount / calibrationFactors[sensorId]);

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
      });
      lastPulseCount[sensorId] = pulseCount;
    }

    // Log flow rate into the database if changed
    if (lastFlowRate[sensorId] !== flowRate) {
      db.run("INSERT INTO flow_rates (sensor_id, flow_rate) VALUES (?, ?)", [sensorId, flowRate], err => {
        if (err) console.error('Error inserting into flow_rates table:', err.message);
      });
      lastFlowRate[sensorId] = flowRate;
    }

    // Log volume into the database if changed significantly
    if (Math.abs(lastVolume[sensorId] - accumulatedVolume) > 0.001) {
      db.run("INSERT INTO volumes (sensor_id, volume) VALUES (?, ?)", [sensorId, accumulatedVolume], err => {
        if (err) console.error('Error inserting into volumes table:', err.message);
      });
      lastVolume[sensorId] = accumulatedVolume;
    }

    // Log median values (throttled to avoid too many writes)
    if (sensorId === 2) { // Only log once per cycle (after all 3 sensors)
      db.run("INSERT INTO median_pulses (median_pulse_count) VALUES (?)", [medianRealTimeData.pulseCount]);
      db.run("INSERT INTO median_flow_rates (median_flow_rate) VALUES (?)", [medianRealTimeData.flowRate]);
      db.run("INSERT INTO median_volumes (median_volume) VALUES (?)", [medianRealTimeData.volume]);
    }
  });
}

// ============================================
// Demo Mode Setup
// ============================================
if (DEMO_MODE) {
  // Handle demo simulator events
  demoSimulator.on('data', (data) => {
    processSensorData(data.sensorId, data.pulseCount, data.flowRate, data.volume);
  });

  demoSimulator.on('systemState', (state) => {
    latestSystemState = state;
    db.run("INSERT INTO system_state (state) VALUES (?)", [state], err => {
      if (err) console.error('Error inserting into system_state table:', err.message);
      else console.log(`[Demo] System state logged: ${state}`);
    });
    io.emit('system-state', state);
  });

  demoSimulator.on('error', (error) => {
    if (error.type === 'Leak Detected') {
      leakDetected = true;
    } else if (error.type === 'Blockage Detected') {
      blockageDetected = true;
    }

    db.run("INSERT INTO error_log (error_type, details) VALUES (?, ?)", [error.type, error.details], err => {
      if (err) console.error('Error inserting into error_log table:', err.message);
      else console.log(`[Demo] Error logged: ${error.type}`);
    });
    io.emit('error-detected', error);
  });

  demoSimulator.on('reset', () => {
    leakDetected = false;
    blockageDetected = false;
    io.emit('system-reset');
  });

  // Start the demo simulator
  demoSimulator.start();
}

// ============================================
// Hardware Mode Setup (Serial Port)
// ============================================
if (!DEMO_MODE) {
  try {
    serialPort = new SerialPort({ path: 'COM15', baudRate: 115200 });
    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

    parser.on('data', data => {
      console.log('Serial data received:', data);
      const trimmedData = data.trim();

      if (trimmedData === 'ON' || trimmedData === 'OFF') {
        latestSystemState = trimmedData;
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
            const pulsesPerSecond = pulseCount;
            const flowRate = (pulsesPerSecond / calibrationFactors[sensorId]) * 60;

            processSensorData(sensorId, pulseCount, flowRate);

            // Hardware mode: detect blockage
            if (latestSystemState === 'ON' && sensorId === 2 && flowRate <= flowRateTolerance) {
              if (!blockageStartTime) {
                blockageStartTime = Date.now();
              } else if (Date.now() - blockageStartTime >= blockageDetectionDelay) {
                blockageDetected = true;
                serialPort.write('P');
                db.run("INSERT INTO error_log (error_type, details) VALUES (?, ?)", ['Blockage Detected', 'Blockage detected between Sensor 2 and Sensor 3.']);
                blockageStartTime = null;
              }
            } else if (sensorId === 2 && flowRate > flowRateTolerance) {
              blockageStartTime = null;
            }

            // Hardware mode: detect leak
            if (latestSystemState === 'ON') {
              const flowRateDiff1 = Math.abs(realTimeData[0].flowRate - realTimeData[1].flowRate);
              const flowRateDiff2 = Math.abs(realTimeData[1].flowRate - realTimeData[2].flowRate);
              const tolerance1 = 0.5 * realTimeData[0].flowRate;
              const tolerance2 = 0.5 * realTimeData[1].flowRate;

              if ((flowRateDiff1 > tolerance1) || (flowRateDiff2 > tolerance2)) {
                if (!leakStartTime) {
                  leakStartTime = Date.now();
                } else if (Date.now() - leakStartTime >= leakDetectionDelay) {
                  leakDetected = true;
                  serialPort.write('P');
                  db.run("INSERT INTO error_log (error_type, details) VALUES (?, ?)", ['Leak Detected', 'Leak detected between sensors.']);
                  leakStartTime = null;
                }
              } else {
                leakStartTime = null;
              }
            }
          }
        });
      }
    });

    serialPort.on('error', (err) => {
      console.error('Serial port error:', err.message);
    });
  } catch (err) {
    console.error('Failed to open serial port:', err.message);
    console.log('Consider running with DEMO_MODE=true');
  }
}

// ============================================
// API Endpoints
// ============================================

// Endpoint to switch system state
app.post('/system/switch', (req, res) => {
  if (DEMO_MODE) {
    demoSimulator.toggleState();
    leakDetected = false;
    blockageDetected = false;
  } else if (serialPort) {
    serialPort.write('P');
    leakDetected = false;
    blockageDetected = false;
  }
  res.json({ message: 'System state switched', demoMode: DEMO_MODE });
});

// Endpoint to get current system state
app.get('/system/state', (req, res) => {
  if (DEMO_MODE) {
    res.json({ state: demoSimulator.getState(), demoMode: true });
  } else if (serialPort) {
    serialPort.write('S');
    setTimeout(() => {
      res.json({ state: latestSystemState, demoMode: false });
    }, 1000);
  } else {
    res.json({ state: latestSystemState, demoMode: false });
  }
});

// Demo control endpoints (only active in demo mode)
app.post('/demo/trigger-leak', (req, res) => {
  if (!DEMO_MODE) {
    return res.status(400).json({ error: 'Demo mode not enabled' });
  }
  demoSimulator.triggerScenario('leak');
  res.json({ message: 'Leak scenario triggered', scenario: 'leak' });
});

app.post('/demo/trigger-blockage', (req, res) => {
  if (!DEMO_MODE) {
    return res.status(400).json({ error: 'Demo mode not enabled' });
  }
  demoSimulator.triggerScenario('blockage');
  res.json({ message: 'Blockage scenario triggered', scenario: 'blockage' });
});

app.post('/demo/reset', (req, res) => {
  if (!DEMO_MODE) {
    return res.status(400).json({ error: 'Demo mode not enabled' });
  }
  demoSimulator.reset();
  leakDetected = false;
  blockageDetected = false;
  res.json({ message: 'Demo reset to normal operation' });
});

app.get('/demo/status', (req, res) => {
  res.json({
    demoMode: DEMO_MODE,
    systemState: DEMO_MODE ? demoSimulator.getState() : latestSystemState,
    leakDetected,
    blockageDetected
  });
});

// Real-time data endpoints
app.get('/realtime/pulses/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  if (realTimeData[sensorId]) {
    res.json([{ pulse_count: realTimeData[sensorId].pulseCount }]);
  } else {
    res.status(500).json({ error: 'No real-time data available' });
  }
});

app.get('/realtime/flow_rates/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  if (realTimeData[sensorId]) {
    res.json([{ flow_rate: realTimeData[sensorId].flowRate }]);
  } else {
    res.status(500).json({ error: 'No real-time data available' });
  }
});

app.get('/realtime/volumes/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  if (realTimeData[sensorId]) {
    res.json([{ volume: realTimeData[sensorId].volume }]);
  } else {
    res.status(500).json({ error: 'No real-time data available' });
  }
});

// Real-time median data endpoints
app.get('/realtime/median_pulses', (req, res) => {
  res.json([{ pulse_count: medianRealTimeData.pulseCount }]);
});

app.get('/realtime/median_flow_rates', (req, res) => {
  res.json([{ flow_rate: medianRealTimeData.flowRate }]);
});

app.get('/realtime/median_volumes', (req, res) => {
  res.json([{ volume: medianRealTimeData.volume }]);
});

// Historical data endpoints with date range filtering
app.get('/history/pulses/:sensorId', (req, res) => {
  const sensorId = req.params.sensorId;
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  db.all("SELECT * FROM pulses WHERE sensor_id = ? AND DATE(timestamp) BETWEEN ? AND ?", [sensorId, startDate, endDate], (err, rows) => {
    if (err) {
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
  db.all("SELECT * FROM flow_rates WHERE sensor_id = ? AND DATE(timestamp) BETWEEN ? AND ?", [sensorId, startDate, endDate], (err, rows) => {
    if (err) {
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
  db.all("SELECT * FROM volumes WHERE sensor_id = ? AND DATE(timestamp) BETWEEN ? AND ?", [sensorId, startDate, endDate], (err, rows) => {
    if (err) {
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
  db.all("SELECT * FROM median_pulses WHERE DATE(timestamp) BETWEEN ? AND ?", [startDate, endDate], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/median_flow_rates', (req, res) => {
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  db.all("SELECT * FROM median_flow_rates WHERE DATE(timestamp) BETWEEN ? AND ?", [startDate, endDate], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/history/median_volumes', (req, res) => {
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  db.all("SELECT * FROM median_volumes WHERE DATE(timestamp) BETWEEN ? AND ?", [startDate, endDate], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Error log endpoint
app.get('/errors', (req, res) => {
  db.all("SELECT * FROM error_log ORDER BY timestamp DESC LIMIT 50", (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Endpoint to get leakDetected and blockageDetected status
app.get('/detection_status', (req, res) => {
  res.json({ leakDetected, blockageDetected, demoMode: DEMO_MODE });
});

// Start server
server.listen(port, () => {
  console.log(`[WLeaks] Server running on port ${port}`);
  console.log(`[WLeaks] Demo mode: ${DEMO_MODE ? 'ENABLED' : 'DISABLED'}`);
  if (DEMO_MODE) {
    console.log('[WLeaks] Demo endpoints available:');
    console.log('  POST /demo/trigger-leak');
    console.log('  POST /demo/trigger-blockage');
    console.log('  POST /demo/reset');
    console.log('  GET  /demo/status');
  }
});
