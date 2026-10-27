import 'dotenv/config';

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { hashPassword } from '../src/common/crypto/hash.js';

async function ask(prompt: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(prompt)).trim();
  } finally {
    readline.close();
  }
}

async function askHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Password input requires an interactive terminal.');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Password entry cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error('This command does not accept command-line arguments.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured.');

  const email = (await ask('Admin email: ')).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const fullName = await ask('Admin full name: ');
  if (!fullName) throw new Error('Full name is required.');
  const password = await askHidden('Admin password (12+ characters): ');
  if (password.length < 12 || password.length > 256) throw new Error('Password must be 12-256 characters.');
  const confirmation = await askHidden('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      'INSERT INTO users (email,password_hash,role) VALUES ($1,$2,$3) RETURNING id',
      [email, await hashPassword(password), 'ADMIN'],
    );
    const user = inserted.rows[0];
    if (!user) throw new Error('Admin creation did not return a user.');
    await client.query('INSERT INTO profiles (user_id,full_name) VALUES ($1,$2)', [user.id, fullName]);
    await client.query('COMMIT');
    stdout.write(`Created ADMIN account for ${email}. MFA enrollment is required at next login.\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Admin creation failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});