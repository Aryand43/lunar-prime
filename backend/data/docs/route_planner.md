# Route planner overview
The route planner finds a conceptual surface traverse on an ideal sphere (radius 1737.4 km) from a start position to a destination, which defaults to the geographic South Pole (latitude -90 degrees, longitude 0 degrees). It minimises a weighted objective of distance, darkness exposure and Earth-invisible exposure. It does not model terrain, slopes, obstacles, vehicle dynamics, batteries, thermal limits or communication link budgets.

# Objective function
cost = w_distance * distance_km / distance_scale_km + w_darkness * darkness_hours / exposure_scale_hours + w_earth_invisible * earth_invisible_hours / exposure_scale_hours. The scales are fixed per request and shared by the optimised route and every baseline, so costs are comparable. A route can be longer than the shortest-distance baseline when the weights value less darkness or Earth-invisible time more than the extra distance.

# Why a route can be longer than the baseline
The shortest-distance baseline minimises distance only and departs immediately. The optimised route minimises the weighted objective. If darkness or Earth-invisible exposure is weighted, a detour through better-lit positions, or waiting for sunrise, can lower the total cost while increasing distance or elapsed time. Compare the per-term cost breakdown (distance, darkness, earth_invisible) of both routes to see which term drove the choice.

# Exposure integration
Sun and Earth elevation are evaluated at the actual moving position and time every sampling step (at most 10 minutes) along each leg and wait, plus the exact partial final sample. Darkness and Earth-invisible durations are integrated over elapsed seconds with linear interpolation of horizon crossings. Waiting time and grid-alignment waiting count toward exposure. Events shorter than the sampling step can be missed.

# Search method and optimality scope
An exact label-setting dynamic programme runs over a time-expanded graph whose states are (waypoint, time-grid index, dwell used at the current stop). The result is optimal only over the chosen time grid, the candidate network and the sampled exposure model. A bounded continuous-time local refinement (remove, replace, shift-departure moves, at most 4,000 evaluations) then improves it. The final route is locally improved, not globally optimal in continuous time.

# Automatic planning network
When enabled, a deterministic generator creates a central great-circle corridor plus lateral corridors between start and destination. Along-track spacing is at most 0.7 times the maximum leg and lateral offset is 0.4 times the maximum leg, so straight and diagonal hops stay within the leg limit. Generated nodes are labelled "Planning waypoint". They are hypothetical and imply no safe terrain, charging, supplies or communications facilities. For near-antipodal endpoints (such as North Pole to South Pole) infinitely many equally short paths exist; one deterministic corridor through an explicit anchor is used and others are not explored.

# Feasibility and binding constraints
A request is infeasible when no route satisfies speed, horizon, leg limit and waiting limit. The great-circle distance divided by speed is a lower bound on travel time; if it exceeds the horizon, the horizon (or speed) is the binding constraint. If no chain of legs within the maximum leg reaches the destination, the leg limit is binding. If grid-alignment waits exceed the per-stop waiting limit, the waiting limit is binding. The planner never silently changes speed, horizon, leg limit or mode.

# Work limits and coarse planning
Work limits are checked before any ephemeris computation: at most 40 bases, 3,000 time steps, 80,000 time-expanded states, 25 million elevation samples, 20,000 ephemeris epochs and 12,000 trajectory points. Requests above the limits are rejected with an explanation. Coarse planning, only when explicitly chosen, uses a single corridor and may coarsen the time grid; every such approximation is listed in the response.

# Departure time sensitivity
Lighting near the poles depends strongly on the subsolar longitude, which moves about 12.2 degrees per day. Changing the departure time changes which side of the pole is lit and can change the chosen corridor. The effect of a different departure must be computed by running a new simulation; it cannot be inferred reliably from the current run.
