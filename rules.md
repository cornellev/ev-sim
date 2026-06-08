# IGVC Competition Rules

This root file preserves the full IGVC rule reference. The docs entry point is [docs/igvc/competition-rules.md](docs/igvc/competition-rules.md), and implementation notes live in [docs/igvc/overview.md](docs/igvc/overview.md).

# III.5 APPENDIX A. Unique SELF DRIVE QUALIFICATION TESTING

## Qualification Test Descriptions

### Test Q.1 Lane Keeping (Go Straight)

#### 1. Test Goal

This test is intended to evaluate if the vehicle is able to stay within lane boundaries, without wheels crossing the line or driving on the line.

*Figure 3: Qualification Testing. Lane Keeping. Go Straight*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 on the side of the road to indicate a starting point at which vehicle is stationary
- Barrel 2 about 50 ft away to indicate an ending point.
- A duct tape’s mark placed 3 ft from the Barrel 2

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 4 – 5 mph)
5. Vehicle reaches full stop within 3 ft from the Barrel 2
6. End test run

#### 4. Evaluation

- **Pass Criteria:** vehicle stays within lane boundaries without wheels crossing the lines or hitting a barrel. Vehicle reaches full stop within 3 ft from Barrel 2.

### Test Q.2 Lines Detection

#### 1. Test Goal

This test is intended to evaluate detection of white and yellow lines using traditional Machine Vision algorithms. There are NO PENALTIES for crossing or moving over a line. A GUI interface with extracted white and yellow lines MUST be present during a run. This test could be performed as a stationary test per judges discretion.

*Figure 4: Qualification Testing. Lines Detection*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. The white and yellow lines must be present on the screen.
4. End test run

#### 4. Evaluation

- **Pass Criteria:** GUI interface is present during the run, correct identification of the lines in front of the vehicle

### Test Q.3 Left Turn

#### 1. Test Goal

This test is intended to evaluate if a vehicle is able to make a left turn across the traffic, merge into expected lane and drive within this lane until an obstacle is detected.

*Figure 5: Qualification Testing. Left Turn*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary. The Barrel 1 could be placed near the stop bar, or several feet away from the stop bar per judges’ decision.
- Barrel 2 to indicate an ending point. The barrel is placed about 30 ft away from the stop bar in the right lane.
- A duct tape’s mark placed 3 ft from the Barrel 2

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 3 – 5 mph)
5. Vehicle turns left across the traffic and merges into correct lane
6. Vehicle maintains the target speed (between 3 – 5 mph)
7. Vehicle reaches full stop within 3 ft from the Barrel 2
8. End test run

#### 4. Evaluation

- **Pass Criteria:** vehicle is able to turn left, merge into correct lane and stop without hitting a barrel or crossing boundaries

### Test Q.4 Right Turn

#### 1. Test Goal

This test is intended to evaluate if the vehicle is able to make a right turn, merge into the lane and drive within a lane until an obstacle is detected.

*Figure 6: Qualification Testing. Right Turn*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate starting point at which vehicle is stationary. The Barrel 1 could be placed near the stop bar, or several feet away from the stop bar per judges’ decision.
- Barrel 2 to indicate an ending point. The barrel is placed about 30 ft away from the stop bar in the right lane
- A duct tape’s mark placed 3 ft from the Barrel 2

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 3 – 5 mph)
5. Vehicle makes right turn and merges into correct lane
6. Vehicle maintains the target speed (between 3 – 5 mph)
7. Vehicle reaches full stop within 3 ft from the Barrel 2
8. End test run

#### 4. Evaluation

- **Pass Criteria:** vehicle is able to turn right, merge into correct lane and stop without hitting a barrel or crossing boundaries

# III.6 APPENDIX B. FUNCTIONS TESTING

Traditional machine vision and signs detection tests require GUI interface with displayed results during the test. The Stop Sign detection test shall display a relevant classification as “Stop Sign” or “Unknown”

## I. Traditional Machine Vision Tests

The goals of the traditional Machine Vision tests are to foster object detection primarily based on shape and color. Traditional machine vision and signs detection tests require GUI interface with displayed results during the test.

### Test FI.1 Static Pedestrian Detection

#### 1. Test Goal

This test is intended to evaluate detection of a mannequin using traditional Machine Vision algorithms. A mannequin wears ORANGE construction vest. A GUI interface with extracted orange blob MUST be present during a run. There are NO PENALTIES for crossing or moving over a line.

*Figure 7: Machine Vision Tests. Static Pedestrian Detection*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate starting point at which vehicle is stationary

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. The extracted orange blob is present on the screen.
4. End test run

#### 4. Evaluation

- **Fail Criteria:** no GUI interface is present during the run, incorrect identification of the shape/object
- **Penalties:** no penalties for crossing or moving over the lines, in case if vehicle is moving during the test

### Test FI.2 Tire Detection

#### 1. Test Goal

This test is intended to evaluate detection of a small item present in a current lane using traditional Machine Vision algorithms. A GUI interface with extracted shape of a tire MUST be present during a run. There are NO PENALTIES for crossing or moving over a line.

*Figure 8: Machine Vision Tests. Tire Detection*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate starting point at which vehicle is stationary

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. The extracted tire is present on the screen
4. End test run

#### 4. Evaluation

- **Fail Criteria:** no GUI interface is present during the run, incorrect identification of the tire
- **Penalties:** no penalties for crossing or moving over the lines, if vehicle is moving during the test

# II. Traffic Sign Tests

### Test FII.1 Stop Sign Detection

#### 1. Test Goal

This test is intended to evaluate Stop Sign classification detection and accuracy. Any type of algorithm could be used for this test. Before test, a RANDOM picture might be put on top of a STOP sign. A forgery sign could be red in color with random letters, be a different color with same letters, or be a different picture. Examples used in the previous years: “Soup” and “IGVC” signs. A GUI interface shell display a relevant classification as “Stop Sign” or “Unknown”. There are NO PENALTIES for crossing or moving over a lane.

*Figure 9: Functions Testing. Stop Sign Detection*

#### 2. Test Setup

- Barrel 1 to indicate starting point at which vehicle is stationary
- 3 different “Stop” signs are being tested randomly

#### 3. Test Script

1. Begin test run
2. The 1st judge inside of the vehicle pushes a 'start' button
3. The extracted sign is shown on the screen with a correct identification
4. The 2nd judge removes a current sign, and puts a new “stop” sign. It could be a fake or a real sign.
5. The extracted sign is shown on the screen with a correct identification
6. The 2nd judge removes a current sign, and puts a new “stop” sign. It could be a fake or a real sign.
7. End test run

#### 4. Evaluation

- **Fail Criteria:** no GUI interface is present during the run, incorrect identification of any of 3 signs, keyboard touching between the sign changes. To pass the test, all 3 signs must be correctly identified.
- **Penalties:** no penalties for crossing or moving over the lines, if vehicle is moving during the test

# III. Intersection Tests

The goals of the Intersection tests are to evaluate vehicle’s ability to maneuver at a road intersection.

### Test FIII.1. Lane Keeping

1. Test Goal This test is intended to evaluate if the vehicle is able maneuver within lane boundaries, without wheels crossing the line or driving on the line. Additionally, this test evaluates if the vehicle stops at the “Stop” sign at the intersection, goes straight through intersection, and stops before an obstacle placed on the road.

*Figure 10: Intersection Tests. Lane Keeping*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- 'Stop' sign
- Barrel 2 to indicate an ending point
- Duct tape’s dashed line to indicate 30 cm from the perpendicular line

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 4 – 5 mph)
5. Vehicle reaches full stop within 30 cm from perpendicular white line next to the "Stop" sign. A vehicle’s bumper should be within two lines at the time when a vehicle reaches full stop.
6. Vehicle takes off from full stop
7. Vehicle maintains the target speed (between 4 – 5 mph)
8. Vehicle reaches full stop within 3 ft the Barrel 2
9. End test run

#### 4. Evaluation

- **Fail Criteria:** crosses white parallel lines, crosses perpendicular white line, stops further than 30 cm from a perpendicular line
- **Penalties:** hits barrel at the end of the run (25 points), stops further than 3 ft from the barrel (10 points)

### Test FIII.2. Intersection Testing. Left Turn

#### 1. Test Goal

This test is intended to evaluate if a vehicle is able to stop at the 'Stop' traffic sign, make a left turn across the traffic, merge into expected lane and drive within this lane until an obstacle is detected.

*Figure 11: Intersection Testing. Left Turn*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- 'Stop' sign
- 'One Way' sign
- Barrel 2 to indicate an ending point
- Duct tape’s dashed line to indicate 30 cm from the perpendicular line

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 4-5 mph)
5. Vehicle reaches full stop within 30 cm from perpendicular white line next to the "Stop" sign. A vehicle’s bumper should be within two lines at the time when a vehicle reaches full stop.
6. Vehicle takes off from full stop
7. Vehicle turns left across the traffic and merges into correct lane
8. Vehicle maintains the target speed (between 4 – 5 mph)
9. Vehicle reaches full stop within 3 ft from the Barrel 2
10. End test run

#### 4. Evaluation

- **Fail Criteria:** crosses white parallel lines, crosses perpendicular white line, makes a wrong turn, stops further than 30 cm from a perpendicular line
- **Penalties:** hits barrel at the end of the run (25 points), stops further than 3 ft from the barrel (10 points)

### Test FIII.3. Intersection Testing. Right Turn

#### 1. Test Goal

This test is intended to evaluate if a vehicle is able to stop at the 'Stop' traffic sign, make a right turn, merge into the lane and drive within a lane until an obstacle is detected.

*Figure 12: Intersection Testing. Right Turn*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- 'Stop' sign
- Barrel 2 to indicate an ending point
- Duct tape’s dashed line to indicate 30 cm from the perpendicular line

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 4 – 5 mph)
5. Vehicle reaches full stop within 30 cm perpendicular white line next to the "Stop" sign. A vehicle’s bumper should be within two lines at the time when a vehicle reaches full stop.
6. Vehicle takes off from full stop
7. Vehicle turns right and merges into correct lane
8. Vehicle maintains the target speed (between 4 – 5 mph)
9. Vehicle reaches full stop within 3 ft from the Barrel 2
10. End test run

#### 4. Evaluation

- **Fail Criteria:** crosses white parallel lines, crosses perpendicular white line, makes a wrong turn, stops further than 30 cm from a perpendicular line
- **Penalties:** hits barrel at the end of the run (25 points), stops further than 3 ft from the barrel (10 points)

# IV. Parking Tests

### Test FIV.1 Parking. Pull Out

#### 1. Test Goal

This test is intended to evaluate if a vehicle is able to reverse out (or pull out) of the representative parking space. The direction of pull out (right-turn-pull-out or left-turn-pull-out) is selected by the judges. The same direction is repeated for all 3 attempts.

*Figure 13: Parking. Pull Out*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- Barrel 2 to indicate an ending point

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle slowly pulls out from the parking spot
5. Vehicle reaches full stop within 3 ft from the Barrel 2
6. End test run

#### 4. Evaluation

- **Fail Criteria:** vehicle crosses solid white lines
- **Penalties:** hits barrel at the end of the run (25 points), stops further than 3 ft from the barrel (10 points)

### Test FIV.2. Parking. Pull In

#### 1. Test Goal

This test is intended to evaluate if a vehicle is able to pull into a representative parking space. The direction of pull in (right-turn-pull-in or left-turn-pull-in) is selected by the judges. The same direction is repeated for all 3 attempts.

*Figure 14(a,b): Functions Testing. Parking. Pull In*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate starting point at which vehicle is stationary

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle slowly pulls into the parking spot
5. Vehicle reaches full stop. It should be fully in the box without crossing any lines
6. End test run

#### 4. Evaluation

- **Fail Criteria:** vehicle crosses solid white lines

### Test FIV.3. Parking. Parallel

#### 1. Test Goal

This test is intended to evaluate if a vehicle is able to parallel park into the representative parking space. The direction of parallel parking (to the right or to the left) is selected by the judges. The same direction is repeated for all attempts.

*Figure 15: Functions Testing. Parking. Parallel*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate starting point at which vehicle is stationary

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle backs off from full stop at Barrel 1
4. Vehicle slowly pulls into the parking spot
5. Vehicle reaches full stop. It should be fully in the box without crossing any lines.
6. End test run

#### 4. Evaluation

- **Fail Criteria:** vehicle crosses solid white line

# V. VRU (Vulnerable Road User) and Obstacle Tests

### Test FV.1 Unobstructed STATIC pedestrian detection

#### 1. Test Goal

This test evaluates ability of Ego vehicle to stop if a pedestrian is detected within boundaries of a current lane.

*Figure 16: Functions Testing. Unobstructed Static Pedestrian Detection*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- Mannequin

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 4 – 5 mph)
5. Vehicle reaches full stop within a range from 7 ft to 5 ft from the Mannequin
6. End test run

#### 4. Evaluation

- **Fail Criteria:** stops further than 7 ft from the mannequin, or hits mannequin
- **Penalties:** hits barrel at the end of the run (25 points), stops closer than 5 ft from the mannequin (10 points)

### Test FV.2 Obstructed DYNAMIC pedestrian detection

#### 1. Test Goal

This test evaluates ability of Ego vehicle to stop if an obstructed by barrel pedestrian (mannequin) suddenly starts crossing an Ego’s vehicle lane.

*Figure 17: Functions Testing. Obstructed Dynamic Pedestrian Detection*

#### 2. Test Setup

- Barrel 1 to indicate a starting point at which vehicle is stationary
- Barrel 2 placed in adjacent lane, with Mannequin behind it
- Barrel 3 to indicate an ending point
- Mannequin

#### 3. Test Script

1. Begin test run
2. Judge 1 pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 3 – 5 mph)
5. Judge 2 rolls out Mannequin from behind Barrel 2 and stops Mannequin in Ego’s vehicle lane
6. Vehicle reaches full stop within a range from 7 ft to 5 ft from the Mannequin
7. Judge 2 pulls back Mannequin behind Barrel 2
8. Vehicle takes off from the full stop
9. Vehicle maintains the target speed (between 3 – 5 mph)
10. Vehicle reaches full stop within 3 ft from the Barrel 2
11. End test run

#### 4. Evaluation

- **Fail Criteria:** stops further than 7 ft from the mannequin, or hits mannequin
- **Penalties:** hits barrel at the end of the run (25 points), stops closer than 5 ft from the Mannequin (10 points)

### Test FV.3 STATIC Pedestrian Detection. Lane Changing

#### 1. Test Goal

This test imitates a situation of a broken vehicle in a current lane with STATIC pedestrian standing in FRONT of barrel(s) in the same lane as Ego vehicle. Ego vehicle must slow down, and safely change into an adjacent lane.

*Figure 18: Functions Testing. Pedestrian Detection. Lane Changing*

#### 2. Test Setup

There will be a distance of approximately 85 ft between the mannequin/barrel when mannequin will start crossing the road. The following items shall be placed on the road:

- Barrel 1 to indicate starting point at which vehicle is stationary
- Mannequin to indicate obstacle
- Barrel 1 and Barrel 2 to indicate a broken vehicle in a current lane
- Barrel 3 to indicate end of a run

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 3 -5 mph)
5. Vehicle detects Mannequin
6. Vehicle performs full transition into the next lane within a range from 13 ft to 10 ft away from the Mannequin
7. Vehicle maintains the target speed in the new lane (between 3-5 mph)
8. Vehicle reaches full stop within 3 ft from the obstacle (Barrel 3)
9. End test run

#### 4. Evaluation

- **Fail Criteria:** hits mannequin, crosses white solid line, lane change completed further than 13 ft away from mannequin
- **Penalties:** hits barrel at the end of the run (25 points), lane change completed closer than 10 feet from the obstacle (10 points)

### Test FV4. Obstacle detection. Lane Changing

#### 1. Test Goal

This test evaluates Ego vehicle’s ability to safely change lane if a stationary object is present within a current lane.

*Figure 19: Functions Testing. Obstacle Detection. Lane Changing*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- Barrel 2 to indicate obstacle
- Barrel 3 to indicate an ending point

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 3 – 5 mph)
5. Vehicle fully moves into the next lane within a range from 13 ft to 10 ft away from the Barrel 2
6. Vehicle maintains the target speed in the new lane (between 3 – 5 mph)
7. Vehicle reaches full stop within 3 ft from the obstacle (Barrel 3)
8. End test run

#### 4. Evaluation

- **Fail Criteria:** hits Barrel 2, crosses white solid line, lane change completed further than 13 ft away from Barrel 2
- **Penalties:** hits Barrel 3 at the end of the run (25 points), lane change completed closer than 10 feet from the obstacle (10 points)

# VI. Curved road Evaluation Tests

The minimum inside curve radius is 10 meters (32.8084 feet).

### Test FVI.1 Curved Road Evaluation. Lane Keeping

#### 1. Test Goal

This test is intended to evaluate Ego vehicle’s ability to stay in the lane on a curved road, and be able to stop at the obstacle within a current lane. This test consists of 4 possible case scenarios: driving in right lane on the left curve, driving in left lane on the left curve, driving in right lane on the right curve and driving in left lane on the right curve. Any of above scenarios could be chosen at judges’ discretion.

*Figure 20: Functions Testing. Curved Road Evaluation. Lane Keeping*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- Barrel 2 to indicate an ending point

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 3 – 5 mph)
5. Vehicle reaches full stop within 3 ft from the Barrel 2
6. End test run

#### 4. Evaluation

- **Fail Criteria:** crosses white solid line
- **Penalties:** hits barrel at the end of the run (25 points), stops further than 3 ft to the Barrel 2 (10 points)

### Test FVI.2 Curved Road Evaluation. Lane Changing

#### 1. Test Goal

This test is intended to evaluate if a vehicle is able to perform a lane change on the curved road if obstacles are detected. This test consists of 4 possible case scenarios: changing right lane on the left curve, changing left lane on the left curve, changing right lane on the right curve and changing left lane on the right curve. Any of above scenarios could be chosen as this year’s test.

*Figure 21: Functions Testing. Curved Road Evaluation. Lane Changing*

*Figure 22: Types of Curved Road Evaluation scenarios*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- Barrel 2 to indicate an obstacle in current lane
- Barrel 3 to indicate an ending point

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 3 – 5 mph)
5. Vehicle detects obstacle (Barrel 2), and safely moves into the next lane
6. Vehicle maintains the target speed in the new lane (between 3 – 5 mph)
7. Vehicle reaches full stop within 3 ft from the obstacle (Barrel 3)
8. End test run

#### 4. Evaluation

- **Fail Criteria:** crosses white solid line, hits Barrel 2
- **Penalties:** hits Barrel 3 at the end of the run (25 points), stops further than 3 ft to the Barrel 2 (10 points)

# VII.

Other Tests

### Test FVII.1 Pothole Detection

#### 1. Test Goal

This test is intended to evaluate Ego vehicle’s ability to detect a pothole and safely change lane.

*Figure 23: Functions Testing. Pothole Detection*

#### 2. Test Setup

The following items shall be placed on the road:

- Barrel 1 to indicate a starting point at which vehicle is stationary
- Pothole (2 feet diameter solid white circle or plastic mirror)
- Barrel 2 to indicate an ending point

#### 3. Test Script

1. Begin test run
2. Judge pushes 'start' button
3. Vehicle takes off from full stop at Barrel 1
4. Vehicle maintains the target speed (between 4 – 5 mph)
5. Vehicle detects pothole and safely moves into the next lane
6. Vehicle maintains the target speed in the new lane (between 4 – 5 mph)
7. Vehicle reaches full stop within 3 ft from the Barrel 2
8. End test run

#### 4. Evaluation

- **Fail Criteria:** run over the pothole
- **Penalties:** hits barrel at the end of the run (25 points), stops further than 3 ft to the Barrel 2 (10 points)
