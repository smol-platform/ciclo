import { buildStandaloneStatus } from "./app.js";

console.log(
  JSON.stringify(
    buildStandaloneStatus(),
    null,
    2
  )
);
