import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { PrismaNeon } from '@prisma/adapter-neon';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL not found in .env');
}

const adapter = new PrismaNeon({ connectionString });

export const prisma = new PrismaClient({ adapter });