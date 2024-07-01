// Flow meter pins
const int flowMeter1Pin = 21; // Flow meter 1
const int flowMeter2Pin = 20; // Flow meter 2
const int flowMeter3Pin = 19; // Flow meter 3

// Pulse counts
volatile unsigned long pulseCount1 = 0;
volatile unsigned long pulseCount2 = 0;
volatile unsigned long pulseCount3 = 0;

// Timing
unsigned long previousMillis = 0;
const long interval = 1000; // Interval for sensor readings and updates

// Define the pin for the push button
const int buttonPin1 = 5; // Button pin

// Variables to store the button state and debounce timing
int buttonState1 = HIGH;         // Initial state of button
int lastButtonState1 = HIGH;     // Previous state of button
unsigned long lastDebounceTime1 = 0;  // Last time button output was toggled
unsigned long debounceDelay = 1;    // Debounce time in milliseconds

// Variables for relay states
bool systemState = false;         // System state (false = not connected to ground)

// Variables for simulated button press
bool simulatedPress = false;
unsigned long simulatedPressTime = 0;
unsigned long pressDuration = 500; // Duration of simulated press in milliseconds

void setup() {
  Serial.begin(115200);

  // Initialize the push button pin as input with internal pull-up resistor
  pinMode(buttonPin1, INPUT_PULLUP);

  // Initialize the flow meter pins
  pinMode(flowMeter1Pin, INPUT_PULLUP);
  pinMode(flowMeter2Pin, INPUT_PULLUP);
  pinMode(flowMeter3Pin, INPUT_PULLUP);

  // Attach interrupts for flow meters
  attachInterrupt(digitalPinToInterrupt(flowMeter1Pin), pulseCounter1, FALLING);
  attachInterrupt(digitalPinToInterrupt(flowMeter2Pin), pulseCounter2, FALLING);
  attachInterrupt(digitalPinToInterrupt(flowMeter3Pin), pulseCounter3, FALLING);

  // Simulate pressing button 1 at startup
  simulateButton1Press();
}

void loop() {
  controlButton();

  unsigned long currentMillis = millis();

  if (currentMillis - previousMillis >= interval) {
    previousMillis = currentMillis;

    // Send raw pulse count data to serial, each on a new line
    Serial.print("FlowMeter1:");
    Serial.println(pulseCount1);
    Serial.print("FlowMeter2:");
    Serial.println(pulseCount2);
    Serial.print("FlowMeter3:");
    Serial.println(pulseCount3);

    // Reset the pulse counts after sending
    pulseCount1 = 0;
    pulseCount2 = 0;
    pulseCount3 = 0;
  }
}

void controlButton() {
  // Check if data is available on the Serial port
  if (Serial.available() > 0) {
    // Read the incoming byte
    char command = Serial.read();

    // Check if the command is to simulate a button press
    if (command == 'P') {
      simulatedPress = true;
      simulatedPressTime = millis();
      // Toggle the system state
      systemState = !systemState;
    }
    // Check if the command is to output the current state
    else if (command == 'S') {
      sendSystemState();
    }
  }

  // Handle the simulated press
  if (simulatedPress) {
    if (millis() - simulatedPressTime < pressDuration) {
      // Simulate button press by temporarily switching pin mode to output and setting it LOW
      pinMode(buttonPin1, OUTPUT);
      digitalWrite(buttonPin1, LOW);
    } else {
      // Simulate button release by switching back to input with pull-up
      pinMode(buttonPin1, INPUT_PULLUP);
      simulatedPress = false;
      // Output the correct system state
      sendSystemState();
    }
  }

  // Read the state of the physical push button for system state tracking
  int reading1 = digitalRead(buttonPin1);

  // Check if the button state has changed
  if (reading1 != lastButtonState1) {
    // Reset the debouncing timer
    lastDebounceTime1 = millis();
  }

  // If the state has been stable for longer than the debounce delay, register the press
  if ((millis() - lastDebounceTime1) > debounceDelay) {
    // If the button state has changed, update the button state
    if (reading1 != buttonState1) {
      buttonState1 = reading1;

      // If the button is pressed and held, update the system state
      if (buttonState1 == LOW) {
        if (!systemState) {
          systemState = true;
          sendSystemState();
        }
      } else {
        if (systemState) {
          systemState = false;
          sendSystemState();
        }
      }
    }
  }

  // Save the reading for button 1. Next time through the loop, it'll be the lastButtonState1
  lastButtonState1 = reading1;
}

void simulateButton1Press() {
  // Simulate pressing button 1 at startup
  pinMode(buttonPin1, OUTPUT);
  digitalWrite(buttonPin1, LOW);
  delay(pressDuration);
  pinMode(buttonPin1, INPUT_PULLUP);

  // Set systemState to true since button 1 was pressed at startup
  systemState = true;

  sendSystemState();
}

void sendSystemState() {
  // Send the system state to the Serial connection with a newline
  Serial.print(systemState ? "OFF\n" : "ON\n");
}

// Interrupt service routines for pulse counting
void pulseCounter1() {
  pulseCount1++;
}

void pulseCounter2() {
  pulseCount2++;
}

void pulseCounter3() {
  pulseCount3++;
}
