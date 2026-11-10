import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  assertSafeWebhookUrl,
  conditionMatches,
} from '../src/modules/automation/automation.engine';

describe('automation engine helpers', () => {
  test('an empty condition always matches', () => {
    assert.equal(conditionMatches(null, { status: 'ASSIGNED' }), true);
    assert.equal(conditionMatches({}, { status: 'ASSIGNED' }), true);
  });

  test('every condition entry must match the payload', () => {
    assert.equal(
      conditionMatches(
        { status: 'ASSIGNED', priority: 'HIGH' },
        { status: 'ASSIGNED', priority: 'HIGH' },
      ),
      true,
    );
    assert.equal(
      conditionMatches(
        { status: 'ASSIGNED', priority: 'HIGH' },
        { status: 'ASSIGNED', priority: 'LOW' },
      ),
      false,
    );
    assert.equal(conditionMatches({ status: 'ASSIGNED' }, {}), false);
  });

  test('non-string condition values are ignored', () => {
    assert.equal(conditionMatches({ limit: 10 } as never, { limit: '10' }), true);
  });

  test('webhook URLs must use HTTPS', async () => {
    await assert.rejects(() => assertSafeWebhookUrl('http://example.com/hook'), /HTTPS/);
  });

  test('webhook URLs must not target private hosts', async () => {
    await assert.rejects(() => assertSafeWebhookUrl('https://localhost/hook'), /public endpoint/);
    await assert.rejects(
      () => assertSafeWebhookUrl('https://api.internal/hook'),
      /public endpoint/,
    );
    await assert.rejects(() => assertSafeWebhookUrl('https://127.0.0.1/hook'), /public endpoint/);
    await assert.rejects(() => assertSafeWebhookUrl('https://10.1.2.3/hook'), /public endpoint/);
    await assert.rejects(
      () => assertSafeWebhookUrl('https://192.168.1.10/hook'),
      /public endpoint/,
    );
    await assert.rejects(
      () => assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data'),
      /public endpoint/,
    );
  });

  test('a hostname that resolves to a private address is rejected', async () => {
    await assert.rejects(
      () =>
        assertSafeWebhookUrl('https://hooks.example.com/hook', async () => [
          { address: '10.0.0.5' },
        ]),
      /public endpoint/,
    );
  });

  test('a public HTTPS endpoint is accepted', async () => {
    const url = await assertSafeWebhookUrl('https://hooks.example.com/hook', async () => [
      { address: '203.0.113.10' },
    ]);
    assert.equal(url.hostname, 'hooks.example.com');
  });
});
