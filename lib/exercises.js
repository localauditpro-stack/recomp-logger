// Training sessions + their exercises, from recomp-master-spec.md section 7.
// training_session enum values: upper_a / lower_a / upper_b / lower_b / rest
// Each exercise carries the rep target range used for double-progression.

export const SESSIONS = [
  { value: "upper_a", label: "Upper A — Strength" },
  { value: "lower_a", label: "Lower A" },
  { value: "upper_b", label: "Upper B — Hypertrophy" },
  { value: "lower_b", label: "Lower B" },
  { value: "rest", label: "Rest day" },
];

export const EXERCISES = {
  upper_a: [
    { name: "Machine chest press (neutral)", range: "6-10" },
    { name: "Lat pulldown (neutral close-grip)", range: "8-10" },
    { name: "Machine shoulder press", range: "8-12" },
    { name: "Chest-supported machine row", range: "8-12" },
    { name: "Cable curl", range: "10-12" },
    { name: "Rope pushdown", range: "10-12" },
  ],
  lower_a: [
    { name: "Belt squat / hack squat (neutral feet)", range: "8-12" },
    { name: "Seated leg curl", range: "10-15" },
    { name: "Leg press (narrow/neutral)", range: "10-15" },
    { name: "Hip thrust machine", range: "10-12" },
    { name: "Leg extension", range: "12-15" },
    { name: "Seated calf raise", range: "12-15" },
    { name: "Cable crunch", range: "12-15" },
  ],
  upper_b: [
    { name: "Incline machine press", range: "8-12" },
    { name: "Cable row (neutral)", range: "10-12" },
    { name: "Cable lateral raise", range: "12-20" },
    { name: "Face pulls (rope)", range: "15-20" },
    { name: "Pec deck (pain-free range)", range: "12-15" },
    { name: "Machine preacher curl", range: "10-12" },
    { name: "Overhead cable triceps ext", range: "12-15" },
  ],
  lower_b: [
    { name: "Hack squat (neutral)", range: "10-12" },
    { name: "Belt squat / leg press", range: "10-15" },
    { name: "Machine leg curl", range: "10-15" },
    { name: "Leg extension", range: "12-15" },
    { name: "Glute kickback", range: "12-15" },
    { name: "Seated calf raise", range: "12-15" },
    { name: "Hanging leg raise", range: "12-15" },
  ],
  rest: [],
};
