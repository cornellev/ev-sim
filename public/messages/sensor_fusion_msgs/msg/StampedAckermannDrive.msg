# Canonical stamped SI Ackermann command for /controls/command.
# Units follow REP-103: meters, radians, seconds. Steering is positive left.
# deadline_ns is absolute simulation time (integer nanoseconds since run start).
# Modes: velocity | acceleration | stop
std_msgs/Header header
uint32 sequence
string mode
float64 deadline_ns
float64 steering_angle
float64 steering_angle_velocity
float64 speed
float64 acceleration
float64 jerk
