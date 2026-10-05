import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
export const researchCases = sqliteTable('research_cases', {
  owner:text('owner').notNull(), id:text('id').notNull(), objectKey:text('object_key').notNull(),
  revision:integer('revision').notNull(),question:text('question').notNull(),createdAt:text('created_at').notNull(),
},table=>[primaryKey({columns:[table.owner,table.id]})]);
export const publicUsage = sqliteTable('public_usage', {
  period:text('period').primaryKey(),caps:text('caps').notNull(), searches:integer('searches').notNull().default(0),
  uploads:integer('uploads').notNull().default(0),requests:integer('requests').notNull().default(0),questions:integer('questions').notNull().default(0),
  busy:text('busy'),
});
export const dailyUsage = sqliteTable('daily_usage', {
  owner:text('owner').notNull(),day:text('day').notNull(),runs:integer('runs').notNull().default(0),nonce:text('nonce').notNull(),
},table=>[primaryKey({columns:[table.owner,table.day]})]);
export const reservations = sqliteTable('usage_reservations', {
  id:text('id').primaryKey(),period:text('period').notNull(),owner:text('owner').notNull(),allocation:text('allocation').notNull(),
  createdAt:text('created_at').notNull(),releasedAt:text('released_at'),
});
export const watchStores = sqliteTable('watch_stores', {
  owner:text('owner').primaryKey(), revision:integer('revision').notNull(),document:text('document').notNull(),
});
