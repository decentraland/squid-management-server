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

export const getPromoteQuery = (serviceName: string, schemaName: string, project: string): SQLStatement => {
  const safeServiceName = escapeLiteral(serviceName)
  const safeProjectName = escapeLiteral(project)

  return SQL`
      DO $$
      DECLARE
          old_schema_name TEXT;
          new_schema_name TEXT;
          writer_user TEXT;
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
