import { config as loadDotenv } from 'dotenv';

// Test commands supply an explicit disposable database and must not inherit
// workstation credentials from .env. The application loader follows the same
// NODE_ENV rule.
if (process.env.NODE_ENV !== 'test') {
  loadDotenv();
}

export default {
  schema: 'prisma/schema.prisma',
};
