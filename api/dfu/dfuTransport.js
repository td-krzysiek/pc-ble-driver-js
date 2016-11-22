'use strict';

const logLevel = require('../util/logLevel');
const DfuObjectWriter = require('./dfuObjectWriter');
const DeviceInfoService = require('./deviceInfoService');
const ControlPointService = require('./controlPointService');
const { InitPacketState, FirmwareState } = require('./dfuModels');
const { ObjectType, ErrorCode, createError } = require('./dfuConstants');
const EventEmitter = require('events');

const MAX_RETRIES = 3;

const DFU_SERVICE_UUID = 'FE59';
const DFU_CONTROL_POINT_UUID = '8EC90001F3154F609FB8838830DAEA50';
const DFU_PACKET_UUID = '8EC90002F3154F609FB8838830DAEA50';

const DEFAULT_CONNECTION_PARAMS = {
    min_conn_interval: 7.5,
    max_conn_interval: 7.5,
    slave_latency: 0,
    conn_sup_timeout: 4000,
};
const DEFAULT_SCAN_PARAMS = {
    active: true,
    interval: 100,
    window: 50,
    timeout: 20,
};


class DfuTransport extends EventEmitter {

    /**
     * Creates a DfuTransport by using the supplied transport parameters.
     *
     * Available transport parameters:
     * - adapter:           An instance of adapter (required)
     * - targetAddress:     The target address to connect to (required)
     * - targetAddressType: The target address type (required)
     * - prnValue:          Packet receipt notification number (optional)
     * - mtuSize:           Maximum transmission unit number (optional)
     *
     * @param transportParameters configuration parameters
     */
    constructor(transportParameters) {
        super();

        if (!transportParameters.adapter) {
            throw new Error('Required transport parameter "adapter" was not provided');
        }
        if (!transportParameters.targetAddress) {
            throw new Error('Required transport parameter "targetAddress" was not provided');
        }

        this._adapter = transportParameters.adapter;
        this._transportParameters = transportParameters;

        this._handleConnParamUpdateRequest = this._handleConnParamUpdateRequest.bind(this);
        this._adapter.on('connParamUpdateRequest', this._handleConnParamUpdateRequest);
        this._isInitialized = false;
    }

    /**
     * Initializes the transport. Connects to the device and sets it up according
     * to the configured transport parameters.
     *
     * @returns Promise that resolves when initialized
     */
    init() {
        if (this._isInitialized) {
            return Promise.resolve();
        }

        const targetAddress = this._transportParameters.targetAddress;
        const targetAddressType = this._transportParameters.targetAddressType;
        const prnValue = this._transportParameters.prnValue;
        const mtuSize = this._transportParameters.mtuSize;

        this._debug(`Initializing DFU transport with targetAddress: ${targetAddress}, ` +
            `targetAddressType: ${targetAddressType}, prnValue: ${prnValue}, mtuSize: ${mtuSize}.`);

        return this._connectIfNeeded(targetAddress, targetAddressType)
            .then(device => this._getCharacteristicIds(device))
            .then(characteristicIds => {
                const controlPointId = characteristicIds.controlPointId;
                const packetId = characteristicIds.packetId;
                this._controlPointService = new ControlPointService(this._adapter, controlPointId);
                this._objectWriter = new DfuObjectWriter(this._adapter, controlPointId, packetId);
                this._objectWriter.on('packetWritten', progress => {
                    this._emitTransferEvent(progress.offset, progress.type);
                });
                return this._startCharacteristicsNotifications(controlPointId);
            })
            .then(() => prnValue ? this._setPrn(prnValue) : null)
            .then(() => mtuSize ? this._setMtuSize(mtuSize) : null)
            .then(() => this._isInitialized = true);
    }

    /**
     * Destroys the transport. Removes all listeners, so that the transport can
     * be garbage collected.
     */
    destroy() {
        if (this._objectWriter) {
            this._objectWriter.removeAllListeners();
        }
        this._adapter.removeListener('connParamUpdateRequest', this._handleConnParamUpdateRequest);
    }


    /**
     * Find the DFU control point and packet characteristic IDs.
     *
     * @param device the device to find characteristic IDs for
     * @returns { controlPointId, packetId }
     * @private
     */
    _getCharacteristicIds(device) {
        const deviceInfoService = new DeviceInfoService(this._adapter, device.instanceId);
        return deviceInfoService.getCharacteristicId(DFU_SERVICE_UUID, DFU_CONTROL_POINT_UUID)
            .then(controlPointCharacteristicId => {
                return deviceInfoService.getCharacteristicId(DFU_SERVICE_UUID, DFU_PACKET_UUID)
                    .then(packetCharacteristicId => {
                        this._debug(`Found controlPointCharacteristicId: ${controlPointCharacteristicId}, ` +
                            `packetCharacteristicId: ${packetCharacteristicId}`);
                        return {
                            controlPointId: controlPointCharacteristicId,
                            packetId: packetCharacteristicId
                        };
                    });
            });
    }


    /**
     * Connect to the target device if not already connected.
     *
     * @param targetAddress the address to connect to
     * @param targetAddressType the target address type
     * @returns Promise that resolves with device when connected
     * @private
     */
    _connectIfNeeded(targetAddress, targetAddressType) {
        const device = this._getConnectedDevice(targetAddress);
        if (device) {
            return Promise.resolve(device);
        } else {
            this._debug(`Connecting to address: ${targetAddress}, type: ${targetAddressType}.`);
            return this._connect(targetAddress, targetAddressType);
        }
    }


    /**
     * Returns connected device for the given address. If there is no connected
     * device for the address, then null is returned.
     *
     * @param targetAddress the address to get connected device for
     * @returns connected device
     * @private
     */
    _getConnectedDevice(targetAddress) {
        const devices = this._adapter.getDevices();
        const deviceId = Object.keys(devices).find(deviceId => {
            return devices[deviceId].address === targetAddress;
        });
        if (deviceId && devices[deviceId].connected) {
            return devices[deviceId];
        }
        return null;
    }


    /**
     * Connect to the target device.
     *
     * @param targetAddress the address to connect to
     * @param targetAddressType the target address type
     * @returns Promise that resolves with device when connected
     * @private
     */
    _connect(targetAddress, targetAddressType) {
        const options = {
            scanParams: DEFAULT_SCAN_PARAMS,
            connParams: DEFAULT_CONNECTION_PARAMS,
        };

        const addressParams = {
            address: targetAddress,
            type: targetAddressType,
        };

        return new Promise((resolve, reject) => {
            this._adapter.connect(addressParams, options, (err, device) => {
                err ? reject(err) : resolve(device);
            });
        });
    }


    /**
     * Wait for the connection to the DFU target to break. Times out with an
     * error if the target is not disconnected within 10 seconds.
     *
     * @returns Promise resolving when the target device is disconnected
     */
    waitForDisconnection() {
        this._debug('Waiting for target device to disconnect.');
        const TIMEOUT_MS = 10000;

        return new Promise((resolve, reject) => {
            const connectedDevice = this._getConnectedDevice(this._transportParameters.targetAddress);
            if (!connectedDevice) {
                this._debug('Already disconnected from target device.');
                return resolve();
            }

            let timeout;
            const disconnectionHandler = device => {
                if (device.instanceId === connectedDevice.instanceId) {
                    clearTimeout(timeout);
                    this._debug('Received disconnection event for target device.');
                    this._adapter.removeListener('deviceDisconnected', disconnectionHandler);
                    resolve();
                }
            };

            timeout = setTimeout(() => {
                this._adapter.removeListener('deviceDisconnected', disconnectionHandler);
                reject(createError(ErrorCode.DISCONNECTION_TIMEOUT,
                    'Timed out when waiting for target device to disconnect.'));
            }, TIMEOUT_MS);

            this._adapter.on('deviceDisconnected', disconnectionHandler);
        });
    }


    /**
     * Sends init packet to the device. If parts of the same init packet has
     * already been sent, then the transfer is resumed.
     *
     * @param data byte array to send to the device
     * @return Promise with empty response
     */
    sendInitPacket(data) {
        this._emitInitializeEvent(ObjectType.COMMAND);
        return this.getInitPacketState(data)
            .then(state => {
                if (state.isResumable) {
                    this._debug(`Resuming init packet: ${state.toString()}`);
                    return this._writeObject(state.remainingData, ObjectType.COMMAND, state.offset, state.crc32);
                }
                this._debug(`Sending new init packet: ${state.toString()}`);
                return this._createAndWriteObject(state.remainingData, ObjectType.COMMAND);
            });
    }

    /**
     * Sends firmware to the device. If parts of the same firmware has already
     * been sent, then the transfer is resumed.
     *
     * @param data byte array to send to the device
     * @returns Promise with empty response
     */
    sendFirmware(data) {
        this._emitInitializeEvent(ObjectType.DATA);
        return this.getFirmwareState(data)
            .then(state => {
                const offset = state.offset;
                const crc32 = state.crc32;
                const objects = state.remainingObjects;

                if (state.isResumable) {
                    const partialObject = state.remainingPartialObject;

                    this._debug(`Completing partial firmware object before proceeding: ${state.toString()}`);
                    return this._writeObject(partialObject, ObjectType.DATA, offset, crc32).then(progress =>
                        this._createAndWriteObjects(objects, ObjectType.DATA, progress.offset, progress.crc32));
                }
                this._debug(`Sending remaining firmware objects: ${state.toString()}`);
                return this._createAndWriteObjects(objects, ObjectType.DATA, offset, crc32);
        });
    }


    /**
     * Returns the current init packet transfer state.
     *
     * @param data the complete init packet byte array
     * @returns Promise that returns an instance of InitPacketState
     */
    getInitPacketState(data) {
        return this.init()
            .then(() => this._controlPointService.selectObject(ObjectType.COMMAND))
            .then(response => {
                this._debug(`Got init packet state from target. Offset: ${response.offset}, ` +
                    `crc32: ${response.crc32}, maximumSize: ${response.maximumSize}.`);

                return new InitPacketState(data, response);
            });
    }

    /**
     * Returns the current firmware transfer state.
     *
     * @param data the complete firmware byte array
     * @returns Promise that returns an instance of FirmwareState
     */
    getFirmwareState(data) {
        return this.init()
            .then(() => this._controlPointService.selectObject(ObjectType.DATA))
            .then(response => {
                this._debug(`Got firmware state from target. Offset: ${response.offset}, ` +
                    `crc32: ${response.crc32}, maximumSize: ${response.maximumSize}.`);

                return new FirmwareState(data, response);
            });
    }

    /**
     * Specifies that the transfer in progress should be interrupted. This will
     * abort before the next packet is written, and throw an error object with
     * code ABORTED.
     */
    abort() {
        this._objectWriter.abort();
    }

    /**
     * Sets packet receipt notification (PRN) value, which specifies how many
     * packages should be sent before receiving receipt.
     *
     * @param prn the PRN value (disabled if 0)
     * @returns Promise with empty response
     * @private
     */
    _setPrn(prn) {
        return this.init()
            .then(() => this._controlPointService.setPRN(prn))
            .then(() => this._objectWriter.setPrn(prn));
    }

    /**
     * Sets maximum transmission unit (MTU) size. This defines the size of
     * packets that are transferred to the device. Default is 20.
     *
     * @param mtuSize the MTU size
     * @private
     */
    _setMtuSize(mtuSize) {
        this._objectWriter.setMtuSize(mtuSize);
    }


    /**
     * Instructs the device to start notifying about changes to the given characteristic id.
     *
     * @returns Promise with empty response
     * @private
     */
    _startCharacteristicsNotifications(characteristicId) {
        return new Promise((resolve, reject) => {
            const ack = false;
            this._adapter.startCharacteristicsNotifications(characteristicId, ack, error => {
                if (error) {
                    reject(createError(ErrorCode.NOTIFICATION_START_ERROR, error.message));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Handle connection parameter update requests from the target device.
     *
     * @param device the device that requested connection parameter update
     * @param connectionParameters connection parameters from device
     * @private
     */
    _handleConnParamUpdateRequest(device, connectionParameters) {
        const connectedDevice = this._getConnectedDevice(this._transportParameters.targetAddress);
        if (connectedDevice && connectedDevice.instanceId === device.instanceId) {
            this._debug('Received connection parameter update request from target device.');
            this._adapter.updateConnectionParameters(device.instanceId, connectionParameters, err => {
                if (err) {
                    throw createError(ErrorCode.CONNECTION_PARAM_ERROR, err.message);
                }
            });
        }
    }

    /**
     * Write an array of objects with the given type, starting at the given
     * offset and crc32.
     *
     * @param objects array of objects (array of byte arrays)
     * @param type the ObjectType to write
     * @param offset the offset to start from
     * @param crc32 the crc32 to start from
     * @return Promise that resolves when the objects have been created and written
     * @private
     */
    _createAndWriteObjects(objects, type, offset, crc32) {
        return objects.reduce((prevPromise, object) => {
            return prevPromise.then(progress =>
                this._createAndWriteObject(object, type, progress.offset, progress.crc32)
            );
        }, Promise.resolve({ offset, crc32 }));
    }

    /**
     * Create and write one object with the given type, starting at the
     * given offset and crc32.
     *
     * @param data the object data to write (byte array)
     * @param type the ObjectType to write
     * @param offset the offset to start from
     * @param crc32 the crc32 to start from
     * @return Promise that resolves when the object has been created and written
     * @private
     */
    _createAndWriteObject(data, type, offset, crc32) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const tryWrite = () => {
                this._controlPointService.createObject(type, data.length)
                    .then(() => this._writeObject(data, type, offset, crc32))
                    .then(progress => resolve(progress))
                    .catch(error => {
                        attempts++;
                        if (this._shouldRetry(attempts, error)) {
                            tryWrite();
                        } else {
                            reject(error);
                        }
                    });
            };
            tryWrite();
        });
    }

    /**
     * Write one object with the given type, starting at the given offset
     * and crc32.
     *
     * @param data the object data to write (byte array)
     * @param type the ObjectType to write
     * @param offset the offset to start from
     * @param crc32 the crc32 to start from
     * @return Promise that resolves when the object has been written
     * @private
     */
    _writeObject(data, type, offset, crc32) {
        return this._objectWriter.writeObject(data, type, offset, crc32)
            .then(progress => {
                return this._validateProgress(progress)
                    .then(() => this._controlPointService.execute())
                    .then(() => progress);
            });
    }

    _shouldRetry(attempts, error) {
        if (attempts < MAX_RETRIES &&
            error.code !== ErrorCode.ABORTED &&
            error.code !== ErrorCode.NOTIFICATION_TIMEOUT) {
            return true;
        }
        return false;
    }

    _validateProgress(progressInfo) {
        return this._controlPointService.calculateChecksum()
            .then(response => {
                // Same checks are being done in objectWriter. Could we reuse?
                if (progressInfo.offset !== response.offset) {
                    throw createError(ErrorCode.INVALID_OFFSET, `Error when validating offset. ` +
                        `Got ${response.offset}, but expected ${progressInfo.offset}.`);
                }
                if (progressInfo.crc32 !== response.crc32) {
                    throw createError(ErrorCode.INVALID_CRC, `Error when validating CRC. ` +
                        `Got ${response.crc32}, but expected ${progressInfo.crc32}.`);
                }
            });
    }

    _emitTransferEvent(offset, type) {
        const event = {
            stage: `Transferring ${this._getObjectTypeString(type)}`
        };
        if (type === ObjectType.DATA) {
            event.offset = offset;
        }
        this.emit('progressUpdate', event);
    }

    _emitInitializeEvent(type) {
        this.emit('progressUpdate', {
            stage: `Initializing ${this._getObjectTypeString(type)}`
        });
    }

    _getObjectTypeString(type) {
        switch (type) {
            case ObjectType.COMMAND:
                return 'init packet';
            case ObjectType.DATA:
                return 'firmware';
        }
        return 'unknown object';
    }

    _debug(message) {
        this.emit('logMessage', logLevel.DEBUG, message);
    }
}

module.exports = DfuTransport;
