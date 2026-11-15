# What Earth visibility means
Earth-visible means the centre of the Earth is above an ideal, terrain-free local horizon (elevation greater than 0 degrees) at the rover's position. It is a geometric line-of-sight condition only. It is not a communication link: antenna pointing, link budgets, ground-station availability, relay satellites and terrain blocking are not modelled. Earth-invisible exposure is the time the Earth centre is at or below the ideal horizon.

# Earth visibility near the south pole
From the near-side south polar region Earth hangs low over the northern horizon and rises and sets with libration (about plus or minus 7 degrees). Small changes in position or time can therefore move Earth across the ideal horizon. On the far side Earth is never above the horizon.

# What darkness means
Darkness means the centre of the Sun is at or below the ideal horizon (elevation at most 0 degrees). The finite solar disc, terrain shadowing and eclipses are not modelled. Geometric sunlight is not electrical power: panel orientation, efficiency, dust and thermal effects are not modelled. At polar sites real terrain dominates illumination; for example crater floors can be permanently shadowed even when this model reports sunlight.

# Data sources for geometry
In SPICE mode, Sun and Earth positions come from NASA/JPL NAIF SPICE generic kernels (DE440s ephemeris, MOON_PA_DE440 orientation, MOON_ME frame, light time plus stellar aberration). Synthetic mode uses a crude analytic model for interface development only: synthetic results are not SPICE results and not NASA data.
