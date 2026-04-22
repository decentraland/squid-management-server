import { Client } from 'pg'
import { SQL, SQLStatement } from 'sql-template-strings'
import { getProjectNameFromService } from './utils'

const client = new Client()

export function escapeLiteral(value: string): string {
  return client.escapeLiteral(value) // Escapes a string safely for use in PostgreSQL
}

export function escapeIdentifier(value: string): string {
  return client.escapeIdentifier(value) // Escapes an identifier (e.g., table names)
}

/**
 * Generates a SQL query to promote a new schema to be the active one for a given service.
 *
 * @param serviceName - The name of the service (e.g., 'squid-marketplace' or 'squid-trades')
 * @param schemaName - The target schema name that will be used (e.g., 'squid_marketplace' or 'squid_trades')
 * @param project - The project name as stored in the squids table
 *
 * This function:
 * 1. Gets the new schema name and its database user from indexers table
 * 2. Gets the old schema name from squids table
 * 3. Renames the current active schema to a backup name
 * 4. Renames the new schema to be the active one
 * 5. Updates the search paths for both the new and old database users
 * 6. Updates the squids table to reflect the new active schema
 */
export const getPromoteQuery = (serviceName: string, schemaName: string, project: string): SQLStatement => {
  const safeServiceName = escapeLiteral(serviceName)
  const safeProjectName = escapeLiteral(project)

  return SQL`
      DO $$
      DECLARE
          old_schema_name TEXT;
          new_schema_name TEXT;
          writer_user TEXT;
          old_user TEXT;
      BEGIN
        -- Fetch the new schema name and database user from the indexers table
        SELECT schema, db_user INTO new_schema_name, writer_user 
        FROM public.indexers 
        WHERE service = `
    .append(safeServiceName)
    .append(
      SQL` 
        ORDER BY created_at DESC LIMIT 1;
        
        -- Fetch the old schema name from the squids table
        SELECT schema INTO old_schema_name 
        FROM squids 
        WHERE name = `
        .append(safeProjectName)
        .append(
          SQL`;
        
        -- Rename the old schema
        EXECUTE format('ALTER SCHEMA %I RENAME TO %I', '`
            .append(schemaName)
            .append(
              SQL`', old_schema_name);
        
        -- Rename the new schema to the desired name
        EXECUTE format('ALTER SCHEMA %I RENAME TO %I', new_schema_name, '`
                .append(schemaName)
                .append(
                  SQL`');
        
        -- Update the search path for the user
        EXECUTE format('ALTER USER %I SET search_path TO %I', writer_user, '`
                    .append(schemaName)
                    .append(
                      SQL`');
        
        SELECT db_user INTO old_user 
        FROM public.indexers 
        WHERE schema = old_schema_name 
        ORDER BY created_at DESC LIMIT 1;

        -- Update the search path for old user to use the old_schema
        EXECUTE format('ALTER USER %I SET search_path TO %I', old_user, old_schema_name);

        -- Update the schema in the squids table
        UPDATE squids 
        SET schema = new_schema_name WHERE name = `.append(safeProjectName).append(SQL`;
      END $$;
  `)
                    )
                )
            )
        )
    )
}

export const getSchemaByServiceNameQuery = (serviceName: string): SQLStatement => {
  return SQL`
      SELECT schema
      FROM public.indexers
      WHERE service = ${serviceName}
      ORDER BY created_at DESC 
      LIMIT 1;
  `
}

export const getActiveSchemaQuery = (serviceName: string): SQLStatement => {
  const projectName = getProjectNameFromService(serviceName)

  return SQL`
      SELECT schema
      FROM public.squids
      WHERE name = ${projectName};
  `
}

/**
 * Lists every schema in the database whose name starts with `squid_`.
 * Used by the purge job to enumerate candidates before filtering by age and usage.
 *
 * Uses a POSIX regex (`~`) rather than `LIKE 'squid_%'` on purpose: in SQL
 * `LIKE`, `_` is a single-character wildcard, so `'squid_%'` also matches e.g.
 * `squida_foo`. The `SAFE_SCHEMA_NAME` regex in the component catches those as
 * `invalid-name`, but narrowing the query itself avoids the wasted round-trip
 * and removes an easy source of confusion.
 */
export const getSquidSchemasQuery = (): SQLStatement => SQL`
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name ~ '^squid_';
`

/**
 * For the supplied schema names, returns the most recent `indexers.created_at`
 * per schema. The purge derives a schema's "age" from this value.
 */
export const getSchemaAgesQuery = (schemaNames: string[]): SQLStatement => SQL`
  SELECT schema, MAX(created_at) AS max_created_at
  FROM public.indexers
  WHERE schema = ANY(${schemaNames})
  GROUP BY schema;
`

/**
 * Returns the schema currently promoted for every project, i.e. the schemas
 * actively being read from. These must never be dropped.
 */
export const getActivelyPromotedSchemasQuery = (): SQLStatement => SQL`
  SELECT schema
  FROM public.squids;
`

/**
 * Builds the `DROP SCHEMA <name> CASCADE` statement. Returned as a plain string
 * (not a SQLStatement) because `<name>` is an identifier, not a parameterisable
 * value — it is safely escaped with pg's `escapeIdentifier` before being
 * interpolated. Callers must still gate the schema name with their own
 * validation before invoking this helper.
 */
export const buildDropSchemaStatement = (schemaName: string): string => `DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`

/**
 * Removes every indexers row that references the given schema. Run inside the
 * same transaction as the corresponding DROP so the deployment history is
 * consistent with the live schema catalog.
 */
export const getDeleteIndexersBySchemaQuery = (schemaName: string): SQLStatement => SQL`
  DELETE FROM public.indexers WHERE schema = ${schemaName};
`
