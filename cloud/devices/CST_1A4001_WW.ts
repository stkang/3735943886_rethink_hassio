import CST_170004_WW from './CST_170004_WW'
import { SWING_AXES_ON_OFF, type WireLevels } from '@/cloud/devices/ac_common'
import type { DeviceDiscovery } from '@/cloud/homeassistant'
import { allowExtendedType } from '@/util/casting'

/*
 * LG indoor unit, ThinQ model CST_1A4001_WW (deviceType 401).
 *
 * It uses the same 0xa7-framed DualCool TLV protocol as CST_170004_WW for the climate core, but
 * its HA shape follows the ThinQ API: 0x205 and 0x206 are independent vertical/horizontal on/off
 * rotation controls. It does not expose the inherited vane-position selector or preset macros.
 */
export default class Device extends CST_170004_WW {
    /*
     * Fan speeds. Labels match the vocabulary exposed for this model by ThinQ.
     */
    readonly fanLevels: WireLevels = [
        ['미약풍', 1],
        ['약풍', 2],
        ['중풍', 4],
        ['강풍', 6],
        ['파워풍', 7],
        ['자동', 8],
    ]

    /* CST_170004_WW registers its own display select directly. Replace that registration locally. */
    addModelFields(config: DeviceDiscovery) {
        super.addModelFields(config)

        const display = config.components.display
        if (display != null) {
            config.components.display = allowExtendedType({
                ...display,
                platform: 'switch',
                name: '디스플레이',
                entity_category: 'config',
                options: undefined,
            })
            const field = this.fields_by_id[0x21f]
            if (field != null) {
                field.read_xform = (raw: number) => (raw === 12 ? 'ON' : raw === 11 ? 'OFF' : undefined)
                field.write_xform = (value: string) => (value === 'ON' ? 12 : value === 'OFF' ? 11 : undefined)
            }
        }
        delete config.components.comfort_saving
        if (config.components.autodry_setting != null) config.components.autodry_setting.name = '자동 건조 시간'
    }

    /* The app exposes automatic plus 30–100 minutes in ten-minute steps. */
    static readonly AUTO_DRY_OPTIONS = ['자동', '30분', '40분', '50분', '60분', '70분', '80분', '90분', '100분']

    /* AI auto-dry is an enable switch (0x20e) plus a separate duration selector. */
    addAutoDryEntities(config: DeviceDiscovery) {
        this.addConfigSwitchField(config, 0x20e, 'autodry', '자동 건조', 'mdi:hair-dryer', {
            onValue: 255,
            offValue: 0,
            readOnValue: 255,
        })

        config.components['autodry_setting'] = allowExtendedType({
            platform: 'select',
            unique_id: '$deviceid-autodry_setting',
            name: '자동 건조 시간',
            icon: 'mdi:hair-dryer',
            entity_category: 'config',
            options: Device.AUTO_DRY_OPTIONS,
            state_topic: '$this/autodry_setting-',
            command_topic: '$this/autodry_setting-/set',
        })

        for (const id of [0x0e7, 0x0f4]) {
            this.addField(
                config,
                {
                    id,
                    name: '',
                    comp: 'autodry_setting',
                    readable: false,
                    writable: false,
                    read_callback: () => {
                        this.publishAutoDrySetting()
                        return false
                    },
                },
                false,
            )
        }

        this.addOptionalSensorField(config, 0x225, 'autodryremain', '자동 건조 잔여', 'mdi:hair-dryer-outline', {
            device_class: 'duration',
            unit_of_measurement: 'min',
            suggested_display_precision: 0,
        })
    }

    autoDrySetting(): string {
        if (this.raw_clip_state[0x0f4] === 2) return '자동'
        const minutes = this.raw_clip_state[0x0e7]
        if (minutes != null && minutes >= 30 && minutes <= 100 && minutes % 10 === 0) return `${minutes}분`
        return '자동'
    }

    publishAutoDrySetting() {
        this.HA.publishProperty(this.id, 'autodry_setting-', this.autoDrySetting())
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'climate-swing_mode' || prop === 'climate-swing_horizontal_mode') {
            const id = prop === 'climate-swing_mode' ? 0x205 : 0x206
            const value = mqttValue === 'on' ? 1 : mqttValue === 'off' ? 0 : undefined
            if (value != null) this.send([1, 1, 2, 1, 1], [{ t: id, v: value }])
            return
        }
        if (prop === 'autodry_setting-') {
            let tlv: { t: number; v: number }[]
            if (mqttValue === '자동') tlv = [{ t: 0x0f4, v: 2 }]
            else if (/^(30|40|50|60|70|80|90|100)분$/.test(mqttValue)) {
                tlv = [{ t: 0x0e7, v: Number.parseInt(mqttValue, 10) }]
            } else return

            for (const { t, v } of tlv) this.raw_clip_state[t] = v
            this.send([1, 1, 2, 1, 1], tlv)
            this.publishAutoDrySetting()
            return
        }
        super.setProperty(prop, mqttValue)
    }

    /* The optional CST comfort-airflow control is not present on this model. */
    addWindModeSelect() {}

    /* 0x205 = vertical rotation, 0x206 = horizontal rotation; each is an independent 0/1 flag. */
    swingAxes() {
        return SWING_AXES_ON_OFF
    }

    /* The parent registers a combined four-state rotation selector; this model uses two axes. */
    addSwingRotation() {}

    /* Presets on CST_170004_WW are model-specific macros and are not part of this model's API. */
    addPresetModes() {}
}
