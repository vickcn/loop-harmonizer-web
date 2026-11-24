import test from 'node:test';
import assert from 'node:assert/strict';
import { readMixerTheme, saveMixerTheme, MIXER_APPEARANCE_KEY } from '../lib/band/mixerAppearance.ts';

test('appearance defaults safely, persists both themes and leaves unrelated device records intact', () => {
  const records = new Map([['project', 'unchanged']]);
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key,value) => records.set(key,value) };
  assert.equal(readMixerTheme(storage), 'graphite');
  assert.equal(saveMixerTheme(storage, 'daylight'), true);
  assert.equal(readMixerTheme(storage), 'daylight');
  assert.equal(records.get('project'), 'unchanged');
  saveMixerTheme(storage, 'graphite');
  assert.equal(readMixerTheme(storage), 'graphite');
  records.set(MIXER_APPEARANCE_KEY, 'invalid');
  assert.equal(readMixerTheme(storage), 'graphite');
});
test('unavailable storage never prevents appearance controls from working', () => {
  const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } };
  assert.equal(readMixerTheme(storage), 'graphite');
  assert.equal(saveMixerTheme(storage, 'daylight'), false);
});
