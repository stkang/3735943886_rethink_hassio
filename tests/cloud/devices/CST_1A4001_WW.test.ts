import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/CST_1A4001_WW'
import HABridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import crc16 from '@/util/crc16'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'CST_1A4001_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: '아이 에어컨', swVersion: '1.0' }

/* Real bridge captures from CST_1A4001_WW after setting 23 C and then strong fan in the LG app. */
const TEMP_23_RESPONSE = '000004000000a70204000c7dc17e407f902e7e887f503b869c'
const STRONG_FAN_RESPONSE = '000004000000a70204000f7dc17e407f902e7e867f503b849050ab3d'

/* ACDevice deliberately accepts only a full initial values response (at least ten TLVs). */
const INITIAL_VALUES: TLV.TLV[] = [
    { t: 0x1f7, v: 1 },
    { t: 0x1f9, v: 0 },
    { t: 0x1fa, v: 8 },
    { t: 0x1fd, v: 59 },
    { t: 0x1fe, v: 46 },
    { t: 0x205, v: 1 },
    { t: 0x206, v: 1 },
    { t: 0x20e, v: 0 },
    { t: 0x21f, v: 200 },
    { t: 0x225, v: 0 },
    { t: 0x2b3, v: 0 },
    { t: 0x321, v: 6 },
]

function deviceFrame(fields: TLV.TLV[], subcommand: 0x01 | 0x04) {
    const payload = TLV.build(fields)
    const body = [0x04, 0x00, 0x00, 0x00, 0xa7, 0x02, subcommand, 0x01, payload.length, ...payload]
    const crc = crc16(body)
    return Buffer.from([0x00, 0x00, ...body, crc >> 8, crc & 0xff])
}

function writtenFields(thinq: MockThinq2Device) {
    const packet = thinq.outbox[thinq.outbox.length - 1]
    assert.ok(packet, 'a packet was sent')
    return TLV.parse(packet.subarray(11, packet.length - 2)).map(({ t, v }) => ({ t, v }))
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    thinq.resetRecorder()

    /* The captured state identifies the value layout; these capability values are shared by the
     * compatible CST family and let the inherited driver build its discovery configuration. */
    thinq.emit(
        'data',
        deviceFrame(
            [
                { t: 0x2cb, v: 0x1006 },
                { t: 0x2cd, v: 0x1fe7b7 },
                { t: 0x2d3, v: 1 },
                { t: 0x2da, v: 0x1234 },
                { t: 0x2e1, v: 32 },
                { t: 0x2e2, v: 60 },
                { t: 0x23f, v: 1 },
                { t: 0x3d6, v: 0 },
            ],
            0x01,
        ),
    )
    thinq.emit('data', deviceFrame(INITIAL_VALUES, 0x04))
    tickMockTimers(t, 1000)
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('is registered by the Home Assistant bridge', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new HABridge(ha.asConnection())

        bridge.newDevice(thinq)
        const dev = bridge.haDevices.get(DEVICE_ID)
        assert.ok(dev instanceof DUT)
        dev.drop()
    })

    test('decodes captured temperature and strong-fan responses', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(TEMP_23_RESPONSE))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 23)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), '자동')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 29.5)

        thinq.emit('data', buf(STRONG_FAN_RESPONSE))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), '강풍')
        dev.drop()
    })

    test('encodes the LG app temperature and strong-fan commands', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('climate-temperature', '23')
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1fe, v: 46 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fa, v: 8 },
        ])

        thinq.resetRecorder()
        dev.setProperty('climate-fan_mode', '강풍')
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1fa, v: 6 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fe, v: 46 },
        ])
        dev.drop()
    })

    test('exposes independent on/off rotations without presets or vane positions', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const climate = ha.devices[DEVICE_ID]?.config?.components.climate as Record<string, unknown> | undefined
        assert.ok(climate)

        assert.deepEqual(climate.swing_modes, ['on', 'off'])
        assert.deepEqual(climate.swing_horizontal_modes, ['on', 'off'])
        assert.equal(climate.preset_modes, undefined)

        /* Discovery fields are installed after the initial frame; the next device report publishes them. */
        thinq.emit(
            'data',
            deviceFrame(
                [
                    { t: 0x205, v: 1 },
                    { t: 0x206, v: 1 },
                ],
                0x04,
            ),
        )
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'on')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'on')
        dev.drop()
    })

    test('exposes only the capabilities supported by this model', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID]?.config?.components as Record<string, Record<string, unknown>>
        const display = components.display
        const autoDry = components.autodry_setting

        assert.equal(display?.platform, 'switch')
        assert.equal(display?.options, undefined)
        assert.equal(components.autodry?.platform, 'switch')
        assert.equal(components.autodry?.command_topic, '$this/autodry-/set')
        assert.equal(components.autodry?.name, '자동 건조')
        assert.equal(components.wind_mode, undefined)
        assert.equal(components.comfort_saving, undefined)
        assert.deepEqual(autoDry?.options, ['자동', '30분', '40분', '50분', '60분', '70분', '80분', '90분', '100분'])
        assert.equal(autoDry?.name, '자동 건조 시간')
        assert.equal(autoDry?.entity_category, 'config')
        assert.equal(autoDry?.state_topic, '$this/autodry_setting-')
        assert.equal(autoDry?.command_topic, '$this/autodry_setting-/set')

        dev.setProperty('display-', 'ON')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x21f, v: 12 }])

        thinq.resetRecorder()
        dev.setProperty('autodry_setting-', '40분')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x0e7, v: 40 }])

        thinq.resetRecorder()
        dev.setProperty('autodry_setting-', '100분')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x0e7, v: 100 }])

        thinq.resetRecorder()
        dev.setProperty('autodry_setting-', '자동')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x0f4, v: 2 }])

        thinq.resetRecorder()
        dev.setProperty('autodry-', 'ON')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x20e, v: 255 }])
        dev.drop()
    })

    test('writes vertical and horizontal rotation flags independently', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('climate-swing_mode', 'off')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x205, v: 0 }])

        thinq.resetRecorder()
        dev.setProperty('climate-swing_horizontal_mode', 'off')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x206, v: 0 }])
        dev.drop()
    })
})
