export function assertStaticRootOutput(config) {
  if(config?.outputDirectory!=='.')throw new Error('Database migration build requires Vercel outputDirectory="." so the static site is served from the project root.');
}

export function deploymentMigrationTarget(env) {
  if(env.VERCEL_ENV==='production'){
    if(env.PERSISTENCE_BACKEND!=='neon'||!env.DATABASE_URL)throw new Error('Migration deployment requires production Neon configuration and DATABASE_URL.');
    if(env.DATABASE_SCHEMA!=='epl_oracle')throw new Error('Migration production deployment requires explicit DATABASE_SCHEMA=epl_oracle.');
    return {schema:'epl_oracle'};
  }
  if(env.VERCEL_ENV==='preview'){
    if(env.PERSISTENCE_BACKEND!=='neon'||!env.DATABASE_URL||!env.DATABASE_SCHEMA) return {skipped:'Preview database migrations skipped: Neon, DATABASE_URL and an isolated DATABASE_SCHEMA are not all configured. Static build continues.'};
    if(!/^[a-z][a-z0-9_]*$/.test(env.DATABASE_SCHEMA))throw new Error('Migration preview requires a valid explicit database schema.');
    if(env.DATABASE_SCHEMA==='epl_oracle')throw new Error('Migration preview requires an isolated nonproduction schema.');
    return {schema:env.DATABASE_SCHEMA};
  }
  return {skipped:'Database migrations skipped outside Vercel production and preview builds.'};
}
