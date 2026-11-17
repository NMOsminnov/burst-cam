import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposureLimit, antiblurSupported } from '../../app/js/core/antiblur.js';

test('предел выдержки: 1/30 с, при зуме от 2× — 1/60 с (единицы 100 мкс)', () => {
  assert.equal(Math.round(exposureLimit(1)), 333);
  assert.equal(Math.round(exposureLimit(1.9)), 333);
  assert.equal(Math.round(exposureLimit(2)), 167);
});

test('поддержка — только при ручной выдержке и ISO (как у телефона автора)', () => {
  const phone = { exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 300000 }, iso: { min: 50, max: 6400 } };
  assert.equal(antiblurSupported(phone), true);
  assert.equal(antiblurSupported({ ...phone, iso: undefined }), false);
  assert.equal(antiblurSupported({ ...phone, exposureMode: ['continuous'] }), false);
  assert.equal(antiblurSupported({}), false);
});
