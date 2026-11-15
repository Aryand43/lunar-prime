// Plain-language explanations shown when "Explain" is on. One sentence (or two) per metric.

export const EXPLAIN = {
  sunlight: "Share of the time the Sun is above the horizon. Solar panels only make power in sunlight.",
  earth: "Share of the time Earth is above the horizon. Without Earth in view there is no direct radio link, and a lander needs a relay satellite.",
  both: "Time when the lander can both make power and talk to Earth.",
  night: "The longest stretch without sunlight. The lander must survive it on batteries and stay warm.",
  earthOutage: "The longest stretch with no direct contact with Earth.",
  sunElevation: "How high the Sun is above the horizon. A higher Sun gives more power on a flat panel.",
  nearHorizon: "How often the Sun or Earth sits right at the horizon. There, a hill or crater rim decides whether it is visible.",
} as const;

export const WHY_THIS_MATTERS =
  "A lander needs the Sun for power and warmth, and Earth in view to talk home without a relay. Near the Moon's south pole both hang close to the horizon, so a small change in place or date can turn days of sunlight into days of darkness. A lunar day lasts about 29.5 Earth days, so a night away from the poles lasts about two weeks.";
