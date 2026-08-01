import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ application_name: "b19-integration-tests", connectionString: databaseUrl })
  : undefined;
const seed = randomUUID();
const departmentId = randomUUID();
const employeeId = randomUUID();
const vehicleId = randomUUID();

describe.runIf(Boolean(databaseUrl))("B19 integration boundary with PostgreSQL", () => {
  beforeAll(async () => {
    await query(`insert into identity.department(id,code,name) values($1,$2,$3)`, [
      departmentId,
      `B19-${seed.slice(0, 8)}`,
      `Отдел B19 ${seed.slice(0, 5)}`,
    ]);
    await query(
      `insert into identity.employee(id,personnel_number,personnel_number_normalized,full_name,department_id)
       values($1,$2,$2,$3,$4)`,
      [employeeId, `B19-${seed.slice(0, 18)}`, "Сотрудник B19", departmentId],
    );
    await query(`insert into logistics.driver_profile(employee_id) values($1)`, [employeeId]);
    await query(
      `insert into logistics.vehicle(id,registration_number,registration_number_normalized,display_name)
       values($1,'А000АА00','А000АА00','Машина B19')`,
      [vehicleId],
    );
  });

  afterAll(async () => pool?.end());

  it("keeps both external systems disabled and exposes stable canonical codes", async () => {
    const systems = await query<{ adapter_kind: string; code: string; status: string }>(
      `select code,status,adapter_kind from integration.external_system order by code`,
    );
    expect(systems.rows).toEqual([
      { adapter_kind: "NONE", code: "AGENT_PLUS", status: "DISABLED" },
      { adapter_kind: "NONE", code: "ONE_C", status: "DISABLED" },
    ]);

    const territory = await query<{ canonical_code: string }>(
      `select canonical_code from logistics.territory where territory_number=9`,
    );
    expect(territory.rows[0]?.canonical_code).toBe("TERRITORY-09");

    const canonical = await query<{ driver_code: string; vehicle_code: string }>(
      `select d.canonical_code driver_code,v.canonical_code vehicle_code
       from logistics.driver_profile d cross join logistics.vehicle v
       where d.employee_id=$1 and v.id=$2`,
      [employeeId, vehicleId],
    );
    expect(canonical.rows[0]?.driver_code).toBe(
      `DRIVER-${employeeId.replaceAll("-", "").toUpperCase()}`,
    );
    expect(canonical.rows[0]?.vehicle_code).toBe(
      `VEHICLE-${vehicleId.replaceAll("-", "").slice(0, 16).toUpperCase()}`,
    );
  });

  it("versions external identifiers without changing the internal key", async () => {
    const mappingId = randomUUID();
    const internalEntityId = vehicleId;
    const canonicalCode = `VEHICLE-${vehicleId.replaceAll("-", "").slice(0, 16).toUpperCase()}`;
    await query(
      `insert into integration.external_identifier(
         id,external_system_code,entity_type,internal_entity_id,canonical_code_snapshot,
         external_identifier,created_by
       ) values($1,'ONE_C','VEHICLE',$2,$3,'EXT-B19-001',$4)`,
      [mappingId, internalEntityId, canonicalCode, employeeId],
    );

    await expect(
      query(
        `insert into integration.external_identifier(
           id,external_system_code,entity_type,internal_entity_id,canonical_code_snapshot,
           external_identifier,created_by
         ) values($1,'ONE_C','VEHICLE',$2,$3,'EXT-B19-002',$4)`,
        [randomUUID(), internalEntityId, canonicalCode, employeeId],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await query(
      `update integration.external_identifier
       set status='RETIRED',valid_until=now(),retired_by=$2,version=version+1
       where id=$1`,
      [mappingId, employeeId],
    );
    await expect(
      query(
        `update integration.external_identifier set external_identifier='REWRITTEN' where id=$1`,
        [mappingId],
      ),
    ).rejects.toThrow("invalid external identifier transition");

    const replacement = randomUUID();
    await query(
      `insert into integration.external_identifier(
         id,external_system_code,entity_type,internal_entity_id,canonical_code_snapshot,
         external_identifier,created_by
       ) values($1,'ONE_C','VEHICLE',$2,$3,'EXT-B19-003',$4)`,
      [replacement, internalEntityId, canonicalCode, employeeId],
    );
    const history = await query<{ external_identifier: string; status: string }>(
      `select external_identifier,status from integration.external_identifier
       where internal_entity_id=$1 order by created_at,id`,
      [internalEntityId],
    );
    expect(history.rows).toEqual([
      { external_identifier: "EXT-B19-001", status: "RETIRED" },
      { external_identifier: "EXT-B19-003", status: "ACTIVE" },
    ]);
  });

  it("protects the outbox payload, idempotency and status machine", async () => {
    const id = randomUUID();
    const correlationId = randomUUID();
    const aggregateId = randomUUID();
    await query(
      `insert into integration.exchange_outbox(
         id,external_system_code,contract_version,message_type,operation_code,aggregate_type,
         aggregate_id,correlation_id,idempotency_key,payload,payload_sha256
       ) values($1,'ONE_C','1.0','OPERATION_POSTED','LOADING_DISPATCH','LOADING_SESSION',
         $2,$3,$4,$5,$6)`,
      [
        id,
        aggregateId,
        correlationId,
        `b19-outbox-${id}`,
        { internalDocumentId: aggregateId },
        "0".repeat(64),
      ],
    );
    await expect(
      query(
        `insert into integration.exchange_outbox(
           id,external_system_code,contract_version,message_type,operation_code,aggregate_type,
           aggregate_id,correlation_id,idempotency_key,payload,payload_sha256
         ) values($1,'ONE_C','1.0','OPERATION_POSTED','LOADING_DISPATCH','LOADING_SESSION',
           $2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          aggregateId,
          correlationId,
          `b19-outbox-${id}`,
          { internalDocumentId: aggregateId },
          "0".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      query(`update integration.exchange_outbox set status='SENT',sent_at=now() where id=$1`, [id]),
    ).rejects.toThrow("invalid integration outbox transition");
    await query(
      `update integration.exchange_outbox
       set status='PROCESSING',locked_at=now(),locked_by='worker-b19',attempts=attempts+1
       where id=$1`,
      [id],
    );
    await query(
      `update integration.exchange_outbox
       set status='SENT',sent_at=now(),locked_at=null,locked_by=null where id=$1`,
      [id],
    );
    await expect(
      query(`update integration.exchange_outbox set payload='{}'::jsonb where id=$1`, [id]),
    ).rejects.toThrow("integration message identity and payload are immutable");
    await expect(
      query(`delete from integration.exchange_outbox where id=$1`, [id]),
    ).rejects.toThrow("integration exchange messages are immutable");
  });

  it("deduplicates inbox messages and preserves quarantined input", async () => {
    const id = randomUUID();
    const correlationId = randomUUID();
    await query(
      `insert into integration.exchange_inbox(
         id,external_system_code,contract_version,source_message_id,message_type,operation_code,
         correlation_id,idempotency_key,payload,payload_sha256
       ) values($1,'AGENT_PLUS','1.0',$2,'MASTER_DATA_UPSERT','PRODUCT_UPSERT',$3,$4,$5,$6)`,
      [
        id,
        `source-${id}`,
        correlationId,
        `b19-inbox-${id}`,
        { productCode: "CAKE-B19" },
        "1".repeat(64),
      ],
    );
    await expect(
      query(
        `insert into integration.exchange_inbox(
           id,external_system_code,contract_version,source_message_id,message_type,operation_code,
           correlation_id,idempotency_key,payload,payload_sha256
         ) values($1,'AGENT_PLUS','1.0',$2,'MASTER_DATA_UPSERT','PRODUCT_UPSERT',$3,$4,$5,$6)`,
        [
          randomUUID(),
          `source-${id}`,
          randomUUID(),
          `another-${id}`,
          { productCode: "OTHER" },
          "2".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await query(
      `update integration.exchange_inbox
       set status='PROCESSING',locked_at=now(),locked_by='worker-b19',attempts=attempts+1 where id=$1`,
      [id],
    );
    await query(
      `update integration.exchange_inbox
       set status='QUARANTINED',quarantined_at=now(),locked_at=null,locked_by=null,
           last_error_code='UNKNOWN_CODE' where id=$1`,
      [id],
    );
    const stored = await query<{ last_error_code: string; status: string }>(
      `select status,last_error_code from integration.exchange_inbox where id=$1`,
      [id],
    );
    expect(stored.rows[0]).toEqual({ last_error_code: "UNKNOWN_CODE", status: "QUARANTINED" });
    await expect(query(`delete from integration.exchange_inbox where id=$1`, [id])).rejects.toThrow(
      "integration exchange messages are immutable",
    );
  });

  it("stores manual reconciliation as immutable revisions", async () => {
    const id = randomUUID();
    await query(
      `insert into integration.manual_reconciliation(
         id,external_system_code,operation_code,internal_object_type,internal_object_id,
         revision_no,result,external_document_number,comment,checked_by,idempotency_key,correlation_id
       ) values($1,'ONE_C','SPOILAGE_WRITEOFF','WRITEOFF_REQUEST',$2,1,'MISMATCH',
         'DEMO-001','Количество не совпало',$3,$4,$5)`,
      [id, randomUUID(), employeeId, `b19-check-${id}`, randomUUID()],
    );
    await expect(
      query(`update integration.manual_reconciliation set result='MATCHED' where id=$1`, [id]),
    ).rejects.toThrow("audit events are immutable");
  });
});

function query<Row extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
) {
  if (!pool) throw new Error("DATABASE_URL is required");
  return pool.query<Row>(text, [...values]);
}
