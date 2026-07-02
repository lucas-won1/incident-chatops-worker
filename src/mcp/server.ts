import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { openSqliteStateStore } from "../state/sqlite-store.js"
import {
  createIncidentHandoffToolHandlers,
  incidentHandoffToolDefinitions,
} from "./handoff-tools.js"

export const registerIncidentHandoffTools = (
  server: McpServer,
  store: Pick<
    ReturnType<typeof openSqliteStateStore>,
    "getIncidentHandoffByIssueId" | "listIncidentHandoffs"
  >,
): void => {
  const handlers = createIncidentHandoffToolHandlers(store)
  server.registerTool(
    "incident_get_handoff",
    incidentHandoffToolDefinitions.incident_get_handoff,
    (input) => handlers.incident_get_handoff(input),
  )
  server.registerTool(
    "incident_list_handoffs",
    incidentHandoffToolDefinitions.incident_list_handoffs,
    (input) => handlers.incident_list_handoffs(input),
  )
  server.registerTool(
    "incident_get_followup_prompt",
    incidentHandoffToolDefinitions.incident_get_followup_prompt,
    (input) => handlers.incident_get_followup_prompt(input),
  )
}

export const startIncidentHandoffMcpServer = async (dbPath: string): Promise<void> => {
  const store = openSqliteStateStore({
    accessMode: "read",
    path: dbPath,
    createIfMissing: false,
  })
  process.once("exit", () => store.close())
  const server = new McpServer({ name: "incident-chatops-worker", version: "0.0.0" })
  registerIncidentHandoffTools(server, store)
  await server.connect(new StdioServerTransport())
}
