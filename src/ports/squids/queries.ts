import SQL, { SQLStatement } from "sql-template-strings";

export const getPromoteQuery = (serviceName: string): SQLStatement => {
  return SQL`
      DO $$
      DECLARE
          old_schema_name TEXT;
          new_schema_name TEXT;
          db_user TEXT;
      BEGIN
        -- Fetch the new schema name and database user from the indexers table
        SELECT schema, db_user INTO new_schema_name, db_user 
        FROM public.indexers 
        WHERE service = ${serviceName};
        
        -- Fetch the old schema name from the squids table
        SELECT schema INTO old_schema_name 
        FROM squids 
        WHERE name = 'marketplace';
        
        -- Rename the old schema
        EXECUTE format('ALTER SCHEMA squid_marketplace RENAME TO %I', old_schema_name);
        
        -- Rename the new schema to the desired name
        EXECUTE format('ALTER SCHEMA %I RENAME TO squid_marketplace', new_schema_name);
        
        -- Update the search path for the user
        EXECUTE format('ALTER USER %I SET search_path TO squid_marketplace', db_user);
        
        -- Update the schema in the squids table
        UPDATE squids SET schema = new_schema_name WHERE name = 'marketplace';
        
      -- Commit the transaction
      COMMIT;
      END $$;
  `;
};
