import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

// Helper to create a mock message object
function createMockMessage({
  to = 'user@example.com',
  from = 'sender@example.com',
  subject = 'Test Subject',
  date = '2025-06-27T12:00:00Z',
  raw = '',
  headers = {} // Map of header name to value
} = {}) {
  return {
    to,
    from,
    raw: new TextEncoder().encode(raw),
    headers: {
      get: (name) => headers[name.toLowerCase()] || '',
    },
  };
}

const env = { NTFY_SERVER: 'https://ntfy.example.com' };

// Extract EmailProcessor class for direct testing
const { EmailProcessor } = worker.__proto__.constructor;

// Mock global fetch
const globalAny = global;
beforeEach(() => {
  globalAny.fetch = vi.fn(() => Promise.resolve({ ok: true }));
});

describe('EmailProcessor', () => {
  it('decodes quoted-printable', () => {
    const processor = new EmailProcessor(env);
    const encoded = 'Hello=2C=20World=21=0A';
    expect(processor.decodeQuotedPrintable(encoded)).toBe('Hello, World!\n');
  });

  it('decodes base64', () => {
    const processor = new EmailProcessor(env);
    const encoded = btoa('Test base64');
    expect(processor.decodeBase64(encoded)).toBe('Test base64');
  });

  it('extracts plain text from simple email', () => {
    const processor = new EmailProcessor(env);
    const raw = 'Header: value\r\n\r\nThis is the body.';
    expect(processor.extractPlainText(raw)).toBe('This is the body.');
  });

  it('cleans body text', () => {
    const processor = new EmailProcessor(env);
    const messy = 'Line 1\n> quoted\nLine 2';
    expect(processor.cleanBodyText(messy)).toBe('Line 1\nLine 2');
  });

  it('truncates long text', () => {
    const processor = new EmailProcessor(env);
    const long = 'a'.repeat(1005);
    expect(processor.truncateText(long, 1000)).toMatch(/truncated/);
  });

  it('generates topic from email', () => {
    const processor = new EmailProcessor(env);
    expect(processor.generateTopic('foo@bar.com')).toBe('bar-com');
  });

  it('sanitizes header', () => {
    const processor = new EmailProcessor(env);
    expect(processor.sanitizeHeader('  test\r\nvalue ')).toBe('test value');
  });

  it('builds markdown payload', () => {
    const processor = new EmailProcessor(env);
    const data = { from: 'a', to: 'b', subject: 'c', date: 'd', body: 'body' };
    expect(processor.buildMarkdownPayload(data)).toMatch(/\*\*From:\*\*/);
  });

  it('sends notification (calls fetch)', async () => {
    const processor = new EmailProcessor(env);
    await processor.sendNotification('topic', 'payload', 'subject', 'to@example.com');
    expect(globalAny.fetch).toHaveBeenCalled();
  });

  it('processes a full email', async () => {
    const processor = new EmailProcessor(env);
    const raw = 'From: sender@example.com\r\nTo: user@example.com\r\nSubject: Test\r\nDate: 2025-06-27\r\n\r\nHello world!';
    const message = createMockMessage({
      to: 'user@example.com',
      from: 'sender@example.com',
      subject: 'Test',
      date: '2025-06-27',
      raw,
      headers: {
        from: 'sender@example.com',
        to: 'user@example.com',
        subject: 'Test',
        date: '2025-06-27',
      },
    });
    await processor.processEmail(message);
    expect(globalAny.fetch).toHaveBeenCalled();
  });
});

describe('Cloudflare Worker email handler', () => {
  it('handles email event without throwing', async () => {
    const raw = 'From: sender@example.com\r\nTo: user@example.com\r\nSubject: Test\r\nDate: 2025-06-27\r\n\r\nHello world!';
    const message = createMockMessage({
      to: 'user@example.com',
      from: 'sender@example.com',
      subject: 'Test',
      date: '2025-06-27',
      raw,
      headers: {
        from: 'sender@example.com',
        to: 'user@example.com',
        subject: 'Test',
        date: '2025-06-27',
      },
    });
    await expect(worker.email(message, env, {})).resolves.not.toThrow();
  });
});

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new Request('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('http://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});
});
