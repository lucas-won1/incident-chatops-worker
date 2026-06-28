import type { Database } from "sql.js"

import { transaction } from "./sqlite-database.js"
import { makeSqliteId } from "./sqlite-ids.js"
import type { MrLinkInput } from "./types.js"

export const saveMrLink = (db: Database, path: string, input: MrLinkInput): void => {
  transaction(db, path, () => {
    db.run(
      `INSERT INTO mr_links (
        mr_link_id, incident_id, job_id, provider, url, created_at
      ) VALUES (
        :mrLinkId, :incidentId, :jobId, :provider, :url, :createdAt
      )`,
      {
        ":mrLinkId": makeSqliteId("mr"),
        ":incidentId": input.incidentId,
        ":jobId": input.jobId,
        ":provider": input.provider,
        ":url": input.url,
        ":createdAt": input.createdAt,
      },
    )
  })
}
