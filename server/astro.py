"""Small, dependency-free positional astronomy helpers.

Precision is "radar display" grade (well under a degree): J2000 coordinates are
used without precession/nutation, and refraction is ignored. Anything that
needs real precision is asked of Stellarium instead.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone

EARTH_RADIUS_KM = 6378.137


def julian_date(moment: datetime) -> float:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp() / 86400.0 + 2440587.5


def gmst_degrees(moment: datetime) -> float:
    jd = julian_date(moment)
    t = (jd - 2451545.0) / 36525.0
    gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - t ** 3 / 38710000.0
    return gmst % 360.0


def radec_to_altaz(ra_deg: float, dec_deg: float, lat_deg: float, lon_deg: float,
                   moment: datetime) -> tuple[float, float]:
    """Return (azimuth from north through east, altitude), degrees."""
    lst = (gmst_degrees(moment) + lon_deg) % 360.0
    hour_angle = math.radians((lst - ra_deg) % 360.0)
    dec = math.radians(dec_deg)
    lat = math.radians(lat_deg)
    sin_alt = math.sin(dec) * math.sin(lat) + math.cos(dec) * math.cos(lat) * math.cos(hour_angle)
    alt = math.asin(max(-1.0, min(1.0, sin_alt)))
    cos_az = (math.sin(dec) - math.sin(alt) * math.sin(lat)) / max(1e-12, math.cos(alt) * math.cos(lat))
    az = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
    if math.sin(hour_angle) > 0:
        az = 360.0 - az
    return az, math.degrees(alt)


def parse_vector(value) -> tuple[float, float, float] | None:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        numbers = [float(item) for item in value]
    else:
        numbers = [float(item) for item in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", str(value or ""))]
    if len(numbers) != 3:
        return None
    length = math.sqrt(sum(item * item for item in numbers)) or 1.0
    return numbers[0] / length, numbers[1] / length, numbers[2] / length


# Stellarium's internal horizontal frame has x towards south and measures the
# vector azimuth counter-clockwise from there; its displayed azimuth is
# 180 degrees minus that angle (north = 0, east = 90).
def stel_altaz_vector_to_azalt(vector) -> tuple[float, float]:
    x, y, z = vector
    az = (180.0 - math.degrees(math.atan2(y, x))) % 360.0
    alt = math.degrees(math.asin(max(-1.0, min(1.0, z))))
    return az, alt


def azalt_to_stel_altaz_vector(az_deg: float, alt_deg: float) -> tuple[float, float, float]:
    phi = math.radians(180.0 - az_deg)
    alt = math.radians(alt_deg)
    return math.cos(alt) * math.cos(phi), math.cos(alt) * math.sin(phi), math.sin(alt)


def j2000_vector_to_radec(vector) -> tuple[float, float]:
    x, y, z = vector
    return math.degrees(math.atan2(y, x)) % 360.0, math.degrees(math.asin(max(-1.0, min(1.0, z))))


def angular_separation(az1: float, alt1: float, az2: float, alt2: float) -> float:
    a1, b1, a2, b2 = map(math.radians, (az1, alt1, az2, alt2))
    cos_d = math.sin(b1) * math.sin(b2) + math.cos(b1) * math.cos(b2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, cos_d))))


def azimuth_delta(a: float, b: float) -> float:
    """Signed shortest rotation from azimuth a to b, degrees."""
    return (b - a + 540.0) % 360.0 - 180.0


def _ecef(lat_deg: float, lon_deg: float, alt_km: float) -> tuple[float, float, float]:
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    r = EARTH_RADIUS_KM + alt_km
    return r * math.cos(lat) * math.cos(lon), r * math.cos(lat) * math.sin(lon), r * math.sin(lat)


def satellite_look_angles(obs_lat: float, obs_lon: float, obs_alt_m: float,
                          sat_lat: float, sat_lon: float, sat_alt_km: float) -> tuple[float, float, float]:
    """Azimuth, elevation (degrees) and slant range (km) from an observer to a
    sub-satellite point. Spherical Earth; fine for a sky plot."""
    ox, oy, oz = _ecef(obs_lat, obs_lon, obs_alt_m / 1000.0)
    sx, sy, sz = _ecef(sat_lat, sat_lon, sat_alt_km)
    dx, dy, dz = sx - ox, sy - oy, sz - oz
    lat, lon = math.radians(obs_lat), math.radians(obs_lon)
    east = -math.sin(lon) * dx + math.cos(lon) * dy
    north = (-math.sin(lat) * math.cos(lon) * dx - math.sin(lat) * math.sin(lon) * dy + math.cos(lat) * dz)
    up = (math.cos(lat) * math.cos(lon) * dx + math.cos(lat) * math.sin(lon) * dy + math.sin(lat) * dz)
    distance = math.sqrt(dx * dx + dy * dy + dz * dz)
    az = math.degrees(math.atan2(east, north)) % 360.0
    el = math.degrees(math.asin(max(-1.0, min(1.0, up / max(distance, 1e-9)))))
    return az, el, distance


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()
