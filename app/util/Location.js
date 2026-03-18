import * as THREE from "three";

/**
 * 
 * @param {Number} lat 
 * @param {Number} lng 
 * @returns {THREE.Vector3}
 */
export const convertFromLatLng = (lat, lng) => {
    const R = 6378137; // Earth’s mean radius in meter
    const x = R * THREE.MathUtils.degToRad(lng);
    const y = R * Math.log(Math.tan(THREE.MathUtils.degToRad(lat) / 2 + Math.PI / 4));
    return new THREE.Vector3(x, 0, y);
}

/**
 * 
 * @param {String} str 
 * @returns {{lat: Number, lng: Number}}
 */
export const convertStringToLatLng = (str) => {
    const [latStr, lngStr] = str.split(" ");
    const latParts = latStr.match(/(\d+)°(\d+)'([\d.]+)"([NS])/);
    const lngParts = lngStr.match(/(\d+)°(\d+)'([\d.]+)"([EW])/);

    const lat = parseInt(latParts[1]) + parseInt(latParts[2]) / 60 + parseFloat(latParts[3]) / 3600;
    const lng = parseInt(lngParts[1]) + parseInt(lngParts[2]) / 60 + parseFloat(lngParts[3]) / 3600;

    return {
        lat: lat * (latParts[4] === "N" ? 1 : -1),
        lng: lng * (lngParts[4] === "E" ? 1 : -1)
    };
}