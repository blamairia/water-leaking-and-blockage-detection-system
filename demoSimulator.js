/**
 * WLeaks Demo Simulator
 * Generates realistic water flow sensor data without hardware
 */

const EventEmitter = require('events');

class DemoSimulator extends EventEmitter {
    constructor() {
        super();

        // Calibration factors (matching real sensors)
        this.calibrationFactors = [342.5, 314, 438.5];

        // Base flow parameters
        this.baseFlowRate = 2.5; // L/min base flow
        this.noiseLevel = 0.15; // Random noise amplitude

        // System state
        this.systemState = false; // OFF initially
        this.isRunning = false;
        this.intervalId = null;

        // Sensor data
        this.sensorData = [
            { pulseCount: 0, flowRate: 0, volume: 0 },
            { pulseCount: 0, flowRate: 0, volume: 0 },
            { pulseCount: 0, flowRate: 0, volume: 0 }
        ];

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
        this.phaseStartTime = Date.now();
        this.cyclePhase = 0;

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

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        console.log('[DemoSimulator] Stopped');
        this.emit('systemState', 'OFF');
    }

    /**
     * Toggle system state
     */
    toggleState() {
        if (this.systemState) {
            this.stop();
        } else {
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
     * Trigger a specific scenario
     */
    triggerScenario(scenario) {
        const validScenarios = ['normal', 'leak', 'blockage'];
        if (!validScenarios.includes(scenario)) {
            console.warn(`[DemoSimulator] Invalid scenario: ${scenario}`);
            return false;
        }

        this.activeScenario = scenario;
        this.scenarioStartTime = Date.now();
        this.autoCycleEnabled = false; // Disable auto-cycle when manually triggered

        console.log(`[DemoSimulator] Triggered scenario: ${scenario}`);
        return true;
    }

    /**
     * Reset to normal operation
     */
    reset() {
        this.activeScenario = 'normal';
        this.scenarioStartTime = null;
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
     * Generate realistic flow data
     */
    generateData() {
        if (!this.systemState) return;

        // Handle auto-cycle phases
        if (this.autoCycleEnabled) {
            this.updateAutoCycle();
        }

        const time = Date.now() / 1000;

        for (let sensorId = 0; sensorId < 3; sensorId++) {
            let flowRate = this.calculateFlowRate(sensorId, time);

            // Apply scenario modifications
            flowRate = this.applyScenario(sensorId, flowRate);

            // Calculate pulse count from flow rate
            const pulsesPerSecond = (flowRate / 60) * this.calibrationFactors[sensorId];
            const pulseCount = Math.round(pulsesPerSecond);

            // Update accumulated volume
            const volumeIncrement = flowRate / 60; // L/s
            this.sensorData[sensorId].volume += volumeIncrement;

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

        return Math.max(0, this.baseFlowRate + pumpVariation + noise + sensorOffset);
    }

    /**
     * Apply active scenario modifications
     */
    applyScenario(sensorId, flowRate) {
        switch (this.activeScenario) {
            case 'leak':
                // Leak between sensor 1 and 2: sensor 2 and 3 read lower
                if (sensorId === 1) {
                    flowRate *= 0.4; // 60% less flow after leak
                } else if (sensorId === 2) {
                    flowRate *= 0.35; // Even less at sensor 3
                }
                break;

            case 'blockage':
                // Blockage before sensor 3: sensor 3 reads near zero
                if (sensorId === 2) {
                    flowRate *= 0.02; // Almost no flow
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
                if (!this.systemState) {
                    this.systemState = true;
                    this.emit('systemState', 'ON');
                }
            } else if (newPhase !== 'startup') {
                this.activeScenario = newPhase;
            }

            console.log(`[DemoSimulator] Auto-cycle phase: ${newPhase}`);
        }
    }

    /**
     * Check if scenario should trigger auto-shutdown
     */
    checkAutoShutdown() {
        if (!this.scenarioStartTime) return;

        const elapsed = Date.now() - this.scenarioStartTime;

        // Shutdown after 3 seconds in error scenario (matching server logic)
        if (elapsed >= 3000 && (this.activeScenario === 'leak' || this.activeScenario === 'blockage')) {
            if (this.systemState) {
                this.systemState = false;
                this.emit('systemState', 'OFF');
                this.emit('error', {
                    type: this.activeScenario === 'leak' ? 'Leak Detected' : 'Blockage Detected',
                    details: this.activeScenario === 'leak'
                        ? 'Leak detected between sensors. System shut down.'
                        : 'Blockage detected between Sensor 2 and Sensor 3. System shut down.'
                });
                console.log(`[DemoSimulator] Auto-shutdown due to ${this.activeScenario}`);
            }
        }
    }
}

module.exports = DemoSimulator;
