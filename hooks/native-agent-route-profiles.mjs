export const ROUTE_CARRIERS = Object.freeze([
  Object.freeze({
    name: "explorer",
    model: "gpt-5.6-luna",
  }),
  Object.freeze({
    name: "worker",
    model: "gpt-5.6-terra",
  }),
  Object.freeze({
    name: "default",
    model: "gpt-5.6-sol",
  }),
]);

export const ROUTE_CARRIER_BY_NAME = new Map(ROUTE_CARRIERS.map((carrier) => [carrier.name, carrier]));

export function routeCarrierFilename(carrier) {
  return `${carrier.name}.toml`;
}

export function renderRouteCarrier(carrier) {
  return [
    "# managed by codex-native-agent-pool-advisor",
    `name = "${carrier.name}"`,
    `description = "Route carrier for ${carrier.model}; select reasoning effort on each dispatch."`,
    `model = "${carrier.model}"`,
    "developer_instructions = \"\"\"",
    "This profile supplies only the selected model route.",
    "The parent must select reasoning effort from the live runtime catalog and pass it explicitly.",
    "Treat the task message as the responsibility contract; this agent type is route transport, not a role.",
    "Do not spawn, close, resume, or otherwise manage child agents.",
    "Return concise evidence or the requested implementation result to the parent.",
    "\"\"\"",
    "",
  ].join("\n");
}
