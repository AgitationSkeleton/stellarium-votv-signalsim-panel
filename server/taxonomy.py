"""Map Stellarium's object-type vocabulary onto one category set and a
hologram model for the console."""
from __future__ import annotations

GAS_GIANTS = {"jupiter", "saturn", "uranus", "neptune"}
RINGED = {"saturn"}

# Stellarium "object-type"/"type" keywords -> category, checked in order.
STELLARIUM_TYPE_KEYWORDS = [
    ("planetary nebula", "planetary nebula"),
    ("supernova remnant", "supernova remnant"),
    ("globular", "cluster"),
    ("open star cluster", "cluster"),
    ("star cluster", "cluster"),
    ("cluster", "cluster"),
    ("association", "cluster"),
    ("star cloud", "cluster"),
    ("quasar", "quasar"),
    ("blazar", "quasar"),
    ("bl lac", "quasar"),
    ("galax", "galaxy"),
    ("nebula", "nebula"),
    ("hii region", "nebula"),
    ("h ii region", "nebula"),
    ("dark nebula", "nebula"),
    ("molecular cloud", "nebula"),
    ("double star", "double star"),
    ("variable star", "variable star"),
    ("nova", "nova"),
    ("meteor shower", "meteor shower"),
    ("comet", "comet"),
    ("dwarf planet", "dwarf planet"),
    ("asteroid", "asteroid"),
    ("minor planet", "asteroid"),
    ("plutino", "asteroid"),
    ("cubewano", "asteroid"),
    ("interstellar", "interstellar object"),
    ("moon", "moon"),
    ("planet", "planet"),
    ("constellation", "constellation"),
    ("artificial", "satellite"),
    ("satellite", "satellite"),
    ("star", "star"),
]


def category_from_stellarium(object_type: str | None, fallback: str) -> str:
    lowered = (object_type or "").lower()
    if not lowered:
        return fallback
    for keyword, category in STELLARIUM_TYPE_KEYWORDS:
        if keyword in lowered:
            # Keep a curated category (e.g. "radio source") when Stellarium is generic
            if fallback in ("radio source", "pulsar", "seti signal", "probe") and category in ("galaxy", "star", "nebula"):
                return fallback
            return category
    return fallback


def satellite_model(name: str) -> str:
    upper = (name or "").upper()
    if any(token in upper for token in ("ISS", "TIANGONG", "CSS (", "TIANHE", "MIR")):
        return "station"
    if " DEB" in upper or upper.endswith("DEB") or "COOLANT" in upper:
        return "debris"
    if "R/B" in upper or "ROCKET" in upper or "AKM" in upper or "BREEZE" in upper or "CENTAUR" in upper:
        return "rocketbody"
    if "STARLINK" in upper or "ONEWEB" in upper or "KUIPER" in upper:
        return "starlink"
    if "HST" in upper or "HUBBLE" in upper:
        return "telescope"
    return "satellite"


def model_for(category: str, name: str = "") -> str:
    key = (name or "").strip().lower()
    if category == "planet" or category == "moon":
        if key == "sun":
            return "star"
        if key == "moon" or category == "moon":
            return "moon"
        if key in RINGED:
            return "ringed"
        return "planet"
    return {
        "sun": "star",
        "dwarf planet": "asteroid",
        "asteroid": "asteroid",
        "interstellar object": "asteroid",
        "comet": "comet",
        "meteor shower": "meteor",
        "satellite": satellite_model(name),
        "probe": "probe",
        "star": "star",
        "double star": "binary",
        "variable star": "star",
        "nova": "nova",
        "galaxy": "galaxy",
        "quasar": "quasar",
        "radio source": "quasar",
        "nebula": "nebula",
        "planetary nebula": "nebula",
        "supernova remnant": "nebula",
        "cluster": "cluster",
        "deep-sky": "galaxy",
        "constellation": "constellation",
        "pulsar": "pulsar",
        "seti signal": "unknown",
        "rf event": "signal",
    }.get(category, "unknown")


def planet_class(name: str) -> str:
    return "gas giant" if (name or "").strip().lower() in GAS_GIANTS else "terrestrial"


CATEGORY_NOTES = {
    "planet": "A major planet of the Solar System. Position and brightness are computed live by Stellarium.",
    "moon": "Earth's natural satellite.",
    "dwarf planet": "A dwarf planet: massive enough to be round, but has not cleared its orbit.",
    "asteroid": "A rocky minor body orbiting the Sun.",
    "interstellar object": "A body on an unbound, hyperbolic trajectory that originated outside the Solar System.",
    "comet": "An icy body that grows a coma and tail when heated near the Sun.",
    "meteor shower": "Debris stream crossed by Earth each year. The listed position is the radiant.",
    "satellite": "An artificial object in Earth orbit (Stellarium Satellites plugin).",
    "probe": "A spacecraft beyond Earth orbit. Position shown is approximate for this epoch.",
    "star": "A star.",
    "double star": "A star system that appears as two or more components.",
    "variable star": "A star whose brightness changes over time.",
    "nova": "A historical nova: a white dwarf's sudden thermonuclear brightening.",
    "galaxy": "A galaxy.",
    "quasar": "An extremely luminous active galactic nucleus.",
    "radio source": "A strong astronomical radio source, a classic calibration target for radio telescopes.",
    "nebula": "A cloud of interstellar gas and dust.",
    "planetary nebula": "Gas shell thrown off by a dying Sun-like star.",
    "supernova remnant": "Expanding debris from a stellar explosion; often a bright radio source.",
    "cluster": "A gravitationally associated group of stars.",
    "deep-sky": "A deep-sky object.",
    "constellation": "One of the 88 IAU constellations.",
    "pulsar": "A rotating neutron star whose beamed radio emission is seen as regular pulses.",
    "seti signal": "A historically notable candidate signal from SETI or transient radio astronomy.",
    "rf event": "A signal logged by the panel's rtl_power band monitor.",
}
