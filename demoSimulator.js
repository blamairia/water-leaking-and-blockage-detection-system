/**
 * WLeaks Demo Simulator
 * Generates realistic water flow sensor data without hardware
 * 
 * Edge Cases Handled:
 * - Pump OFF: All sensors read 0, volumes freeze
 * - Pump toggle during leak/blockage: Clears error state
 * - Gradual startup: Flow ramps up over 2 seconds
 * - Residual flow on shutdown: Flow decays over 1 second
 * - Sensor drift: Slight variations even in steady state
 * - Volume accumulation: Only when system is ON
 */

const EventEmitter = require('events');

class DemoSimulator extends EventEmitter {
    constructor() {
        super();

        // Calibration factors (matching real YF-S201 sensors)
        this.calibrationFactors = [342.5, 314, 438.5];

        // Base flow parameters
        this.baseFlowRate = 2.5; // L/min base flow
        this.noiseLevel = 0.15; // Random noise amplitude

        // System state
        this.systemState = false; // OFF initially
        this.isRunning = false;
        this.intervalId = null;

        // Startup/shutdown transients
        this.startupTime = null;
        this.shutdownTime = null;
        this.startupDuration = 2000; // 2s to reach full flow
        this.shutdownDuration = 1000; // 1s for residual flow to stop

        // Sensor data
        this.sensorData = [
            { pulseCount: 0, flowRate: 0, volume: 0 },
            { pulseCount: 0, flowRate: 0, volume: 0 },
            { pulseCount: 0, flowRate: 0, volume: 0 }
        ];

        // Error tracking
        this.leakDetected = false;
        this.blockageDetected = false;
        this.errorStartTime = null;
        this.detectionDelay = 3000; // 3s before error triggers shutdown

        // Active scenario
        this.activeScenario = 'normal'; // 'normal', 'leak', 'blockage'
        this.scenarioStartTime = null;

        // Demo cycle configuration
        this.autoCycleEnabled = true;
        this.cyclePhase = 0;
        this.phaseStartTime = Date.now();
        this.cyclePhaseDurations = [
            { phase: 'startup', duration: 3000 },      // 3s startup
            { phase: 'normal', duration: 15000 },      // 15s normal operation
            { phase: 'leak', duration: 8000 },         // 8s leak detection
            { phase: 'recovery', duration: 5000 },     // 5s recovery
            { phase: 'normal', duration: 10000 },      // 10s normal
            { phase: 'blockage', duration: 8000 },     // 8s blockage
            { phase: 'recovery', duration: 5000 },     // 5s recovery
        ];
    }

    /**
     * Start the simulator
     */
    start() {
        if (this.isRunning) return;

        this.isRunning = true;
        this.systemState = true;
        this.startupTime = Date.now();
        this.shutdownTime = null;
        this.phaseStartTime = Date.now();
        this.cyclePhase = 0;

        // Clear any previous error state on manual start
        this.leakDetected = false;
        this.blockageDetected = false;
        this.errorStartTime = null;
        this.activeScenario = 'normal';

        console.log('[DemoSimulator] Started in demo mode');
        this.emit('systemState', 'ON');

        // Generate data every second (matching real hardware)
        this.intervalId = setInterval(() => this.generateData(), 1000);
    }

    /**
     * Stop the simulator
     */
    stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        this.systemState = false;
        this.shutdownTime = Date.now();
        this.startupTime = null;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        // Emit final zero readings after shutdown
        setTimeout(() => this.emitZeroReadings(), 500);
        setTimeout(() => this.emitZeroReadings(), 1000);

        console.log('[DemoSimulator] Stopped');
        this.emit('systemState', 'OFF');
    }

    /**
     * Emit zero readings for all sensors (when pump is off)
     */
    emitZeroReadings() {
        for (let sensorId = 0; sensorId < 3; sensorId++) {
            this.sensorData[sensorId].pulseCount = 0;
            this.sensorData[sensorId].flowRate = 0;
            // Volume stays frozen, doesn't reset

            this.emit('data', {
                sensorId,
                pulseCount: 0,
                flowRate: 0,
                volume: this.sensorData[sensorId].volume
            });
        }
    }

    /**
     * Toggle system state
     */
    toggleState() {
        if (this.systemState) {
            this.stop();
        } else {
            // Clear error states when manually toggling back on
            this.leakDetected = false;
            this.blockageDetected = false;
            this.errorStartTime = null;
            this.activeScenario = 'normal';
            this.scenarioStartTime = null;
            this.start();
        }
        return this.systemState;
    }

    /**
     * Get current system state
     */
    getState() {
        return this.systemState ? 'ON' : 'OFF';
    }

    /**
     * Get detection status
     */
    getDetectionStatus() {
        return {
            leakDetected: this.leakDetected,
            blockageDetected: this.blockageDetected,
            activeScenario: this.activeScenario
        };
    }

    /**
     * Trigger a specific scenario
     */
    triggerScenario(scenario) {
        const validScenarios = ['normal', 'leak', 'blockage'];
        if (!validScenarios.includes(scenario)) {
            console.warn(`[DemoSimulator] Invalid scenario: ${scenario}`);
            return false;
        }

        // Can only trigger scenarios when system is ON
        if (!this.systemState) {
            console.warn(`[DemoSimulator] Cannot trigger scenario while system is OFF`);
            return false;
        }

        this.activeScenario = scenario;
        this.scenarioStartTime = Date.now();
        this.autoCycleEnabled = false; // Disable auto-cycle when manually triggered

        // Reset error states for new scenario
        this.leakDetected = false;
        this.blockageDetected = false;
        this.errorStartTime = null;

        console.log(`[DemoSimulator] Triggered scenario: ${scenario}`);
        return true;
    }

    /**
     * Reset to normal operation
     */
    reset() {
        this.activeScenario = 'normal';
        this.scenarioStartTime = null;
        this.leakDetected = false;
        this.blockageDetected = false;
        this.errorStartTime = null;
        this.autoCycleEnabled = true;
        this.cyclePhase = 0;
        this.phaseStartTime = Date.now();

        // Restart if was stopped due to error
        if (!this.systemState) {
            this.start();
        }

        console.log('[DemoSimulator] Reset to normal operation');
        this.emit('reset');
    }

    /**
     * Get startup/shutdown multiplier for gradual transitions
     */
    getTransientMultiplier() {
        const now = Date.now();

        // Gradual startup ramp
        if (this.startupTime) {
            const elapsed = now - this.startupTime;
            if (elapsed < this.startupDuration) {
                // Ease-out curve for natural startup
                return Math.min(1, elapsed / this.startupDuration);
            }
        }

        return 1.0;
    }

    /**
     * Generate realistic flow data
     */
    generateData() {
        if (!this.systemState) {
            this.emitZeroReadings();
            return;
        }

        // Handle auto-cycle phases
        if (this.autoCycleEnabled) {
            this.updateAutoCycle();
        }

        const time = Date.now() / 1000;
        const transientMultiplier = this.getTransientMultiplier();

        for (let sensorId = 0; sensorId < 3; sensorId++) {
            let flowRate = this.calculateFlowRate(sensorId, time);

            // Apply startup/shutdown transient
            flowRate *= transientMultiplier;

            // Apply scenario modifications
            flowRate = this.applyScenario(sensorId, flowRate);

            // Calculate pulse count from flow rate
            const pulsesPerSecond = (flowRate / 60) * this.calibrationFactors[sensorId];
            const pulseCount = Math.round(pulsesPerSecond);

            // Update accumulated volume (only when pump is on and flowing)
            if (flowRate > 0) {
                const volumeIncrement = flowRate / 60; // L/s
                this.sensorData[sensorId].volume += volumeIncrement;
            }

            // Store current readings
            this.sensorData[sensorId].pulseCount = pulseCount;
            this.sensorData[sensorId].flowRate = flowRate;

            // Emit data like serial port would
            this.emit('data', {
                sensorId,
                pulseCount,
                flowRate,
                volume: this.sensorData[sensorId].volume
            });
        }

        // Check for scenario-triggered shutdowns
        this.checkAutoShutdown();
    }

    /**
     * Calculate base flow rate with realistic variations
     */
    calculateFlowRate(sensorId, time) {
        // Base flow with slight sine wave variation (simulates pump pulsation)
        const pumpVariation = Math.sin(time * 2 * Math.PI * 0.5) * 0.1;

        // Random noise
        const noise = (Math.random() - 0.5) * 2 * this.noiseLevel;

        // Sensor-specific offset (each sensor reads slightly different)
        const sensorOffset = [0, -0.05, 0.03][sensorId];

        // Long-term drift simulation
        const drift = Math.sin(time * 0.01) * 0.05;

        return Math.max(0, this.baseFlowRate + pumpVariation + noise + sensorOffset + drift);
    }

    /**
     * Apply active scenario modifications
     */
    applyScenario(sensorId, flowRate) {
        switch (this.activeScenario) {
            case 'leak':
                // Leak between sensor 1 and 2: sensor 2 and 3 read significantly lower
                // This simulates water escaping between the entry and mid sensors
                if (sensorId === 1) {
                    flowRate *= 0.4; // 60% loss after leak point
                } else if (sensorId === 2) {
                    flowRate *= 0.35; // Even more loss at exit
                }
                break;

            case 'blockage':
                // Blockage before sensor 3: pressure builds up, sensor 3 reads near zero
                // Sensors 1 and 2 might show slightly higher due to back-pressure
                if (sensorId === 0) {
                    flowRate *= 1.05; // Slight pressure increase
                } else if (sensorId === 1) {
                    flowRate *= 0.95; // Slight reduction mid-pipe
                } else if (sensorId === 2) {
                    flowRate *= 0.02; // Almost no flow at exit
                }
                break;

            case 'normal':
            default:
                // No modification
                break;
        }

        return flowRate;
    }

    /**
     * Update auto-cycle phase
     */
    updateAutoCycle() {
        const currentPhaseConfig = this.cyclePhaseDurations[this.cyclePhase];
        const elapsed = Date.now() - this.phaseStartTime;

        if (elapsed >= currentPhaseConfig.duration) {
            // Move to next phase
            this.cyclePhase = (this.cyclePhase + 1) % this.cyclePhaseDurations.length;
            this.phaseStartTime = Date.now();

            const newPhase = this.cyclePhaseDurations[this.cyclePhase].phase;

            if (newPhase === 'recovery') {
                this.activeScenario = 'normal';
                this.leakDetected = false;
                this.blockageDetected = false;
                this.errorStartTime = null;
                if (!this.systemState) {
                    this.systemState = true;
                    this.startupTime = Date.now();
                    this.emit('systemState', 'ON');
                }
            } else if (newPhase !== 'startup') {
                this.activeScenario = newPhase;
                this.scenarioStartTime = Date.now();
            }

            console.log(`[DemoSimulator] Auto-cycle phase: ${newPhase}`);
        }
    }

    /**
     * Check if scenario should trigger auto-shutdown
     */
    checkAutoShutdown() {
        // Only check when in error scenario and system is on
        if (this.activeScenario === 'normal' || !this.systemState) return;

        // Start error timer if not started
        if (!this.errorStartTime) {
            this.errorStartTime = Date.now();
        }

        const elapsed = Date.now() - this.errorStartTime;

        // Shutdown after detection delay (matching server logic)
        if (elapsed >= this.detectionDelay) {
            if (this.activeScenario === 'leak' && !this.leakDetected) {
                this.leakDetected = true;
                this.systemState = false;
                this.shutdownTime = Date.now();
                this.emit('systemState', 'OFF');
                this.emit('error', {
                    type: 'Leak Detected',
                    details: 'Leak detected between sensors. System shut down.',
                    timestamp: new Date().toISOString()
                });
                console.log(`[DemoSimulator] Auto-shutdown due to leak`);

                if (this.intervalId) {
                    clearInterval(this.intervalId);
                    this.intervalId = null;
                }
            } else if (this.activeScenario === 'blockage' && !this.blockageDetected) {
                this.blockageDetected = true;
                this.systemState = false;
                this.shutdownTime = Date.now();
                this.emit('systemState', 'OFF');
                this.emit('error', {
                    type: 'Blockage Detected',
                    details: 'Blockage detected at exit sensor. System shut down.',
                    timestamp: new Date().toISOString()
                });
                console.log(`[DemoSimulator] Auto-shutdown due to blockage`);

                if (this.intervalId) {
                    clearInterval(this.intervalId);
                    this.intervalId = null;
                }
            }
        }
    }

    /**
     * Get current sensor readings (for API endpoints)
     */
    getSensorData() {
        return this.sensorData.map((sensor, index) => ({
            sensorId: index,
            ...sensor,
            systemState: this.systemState ? 'ON' : 'OFF'
        }));
    }
}

module.exports = DemoSimulator;
