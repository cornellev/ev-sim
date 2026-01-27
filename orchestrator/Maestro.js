
function ros_installed() {
    const process = require('child_process');
    try {
        process.execSync('rosversion -d', { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

const rosnodejs = ros_installed() ? require('rosnodejs') : null;


class ROSMaestro {
    static _setup = false;
    static std_msgs = null;

    static setup() {
        if (this._setup) return;
        this.std_msgs = rosnodejs.require('std_msgs').msg;
        this._setup = true;
    }

    constructor() {
        if (!ros_installed()) throw new Error("ROS is not installed.");
    }
}

if (ros_installed()) {
    module.exports = ROSMaestro;
} else {
    console.warn("ROS is not installed. Maestro will not be available.");
    module.exports = null;
}