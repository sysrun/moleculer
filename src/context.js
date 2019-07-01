/*
 * moleculer
 * Copyright (c) 2018 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

//const Promise = require("bluebird");
const util = require("util");
const _ = require("lodash");
const { RequestSkippedError, MaxCallLevelError } = require("./errors");

/**
 * Merge metadata
 *
 * @param {Object} newMeta
 *
 * @private
 * @memberof Context
 */
function mergeMeta(ctx, newMeta) {
	if (newMeta)
		Object.assign(ctx.meta, newMeta);
	return ctx.meta;
}

/**
 * Context class for action calls
 *
 * @property {String} id - Context ID
 * @property {ServiceBroker} broker - Broker instance
 * @property {Action} action - Action definition
 * @property {String} [nodeID=null] - Node ID
 * @property {String} parentID - Parent Context ID
 * @property {Boolean} tracing - Enable tracing
 * @property {Number} [level=1] - Level of context
 *
 * @class Context
 */
class Context {

	/**
	 * Creates an instance of Context.
	 *
	 * @param {ServiceBroker} broker - Broker instance
	 * @param {Endpoint} endpoint
	 *
	 * @memberof Context
	 */
	constructor(broker, endpoint) {
		this._id = null;

		this.broker = broker;
		if (this.broker)
			this.nodeID = this.broker.nodeID;
		else
			this.nodeID = null;

		if (endpoint) {
			this.setEndpoint(endpoint);
		} else {
			this.endpoint = null;
			this.service = null;
			this.action = null;
			this.event = null;
		}

		// The emitted event "user.created" because `ctx.event.name` can be "user.**"
		this.eventName = null;
		// Type of event ("emit" or "broadcast")
		this.eventType = null;
		// The groups of event
		this.eventGroups = null;

		this.options = {
			timeout: null,
			retries: null,
		};

		this.parentID = null;
		this.caller = null;

		this.level = 1;

		this.params = null;
		this.meta = {};

		this.requestID = null;

		this.tracing = null;
		this.span = null;

		this.needAck = null;
		this.ackID = null;

		//this.startTime = null;
		//his.startHrTime = null;
		//this.stopTime = null;
		//this.duration = null;

		//this.error = null;
		this.cachedResult = false;
	}

	/**
	 * Create a new Context instance
	 *
	 * @param {ServiceBroker} broker
	 * @param {Endpoint} endpoint
	 * @param {Object?} params
	 * @param {Object} opts
	 * @returns {Context}
	 *
	 * @static
	 * @memberof Context
	 */
	static create(broker, endpoint, params, opts = {}) {
		const ctx = new broker.ContextFactory(broker, endpoint);

		if (endpoint != null)
			ctx.setEndpoint(endpoint);

		if (params != null) {
			let cloning = broker ? broker.options.contextParamsCloning : false;
			if (opts.paramsCloning != null)
				cloning = opts.paramsCloning;
			ctx.setParams(params, cloning);
		}

		//Object.assign(ctx.options, opts);
		ctx.options = opts;

		// RequestID
		if (opts.requestID != null)
			ctx.requestID = opts.requestID;
		else if (opts.parentCtx != null && opts.parentCtx.requestID != null)
			ctx.requestID = opts.parentCtx.requestID;

		// Meta
		if (opts.parentCtx != null && opts.parentCtx.meta != null)
			ctx.meta = _.assign({}, opts.parentCtx.meta, opts.meta);
		else if (opts.meta != null)
			ctx.meta = opts.meta;

		// ParentID, Level, Caller
		if (opts.parentCtx != null) {
			ctx.parentID = opts.parentCtx.id;
			ctx.level = opts.parentCtx.level + 1;
			if (opts.parentCtx.action)
				ctx.caller = opts.parentCtx.action.name;
			else if (opts.parentCtx.event)
				ctx.caller = opts.parentCtx.event.name;
		}

		// Tracing
		if (opts.parentCtx != null)
			ctx.tracing = opts.parentCtx.tracing;

		// Event acknowledgement
		if (opts.needAck) {
			ctx.needAck = opts.needAck;
		}

		return ctx;
	}

	/**
	 * Copy itself without ID.
	 * @param {Endpoint} ep
	 * @returns {Context}
	 */
	copy(ep) {
		const newCtx = new this.constructor();

		newCtx.broker = this.broker;
		newCtx.nodeID = this.nodeID;
		newCtx.setEndpoint(ep || this.endpoint);
		newCtx.options = this.options;
		newCtx.parentID = this.parentID;
		newCtx.caller = this.caller;
		newCtx.level = this.level;
		newCtx.params = this.params;
		newCtx.meta = this.meta;
		newCtx.requestID = this.requestID;
		newCtx.tracing = this.tracing;
		newCtx.span = this.span;
		newCtx.needAck = this.needAck;
		newCtx.ackID = this.ackID;
		newCtx.eventName = this.eventName;
		newCtx.eventType = this.eventType;
		newCtx.eventGroups = this.eventGroups;

		newCtx.cachedResult = this.cachedResult;

		return newCtx;
	}

	/**
	 * Context ID getter
	 *
	 * @readonly
	 * @memberof Context
	 */
	get id() {
		if (!this._id) {
			this._id = this.broker.generateUid();
			if (!this.requestID)
				this.requestID = this._id;
		}
		return this._id;
	}

	/**
	 * Context ID setter
	 *
	 * @memberof Context
	 */
	set id(val) {
		this._id = val;
	}

	/**
	 * Set endpoint of context
	 *
	 * @param {Endpoint} endpoint
	 * @memberof Context
	 */
	setEndpoint(endpoint) {
		this.endpoint = endpoint;
		if (endpoint && endpoint.action) {
			this.action = endpoint.action;
			this.service = this.action.service;
			this.event = null;
		} else if (endpoint && endpoint.event) {
			this.event =  endpoint.event;
			this.service = this.event.service;
			this.action = null;
		}

		if (endpoint)
			this.nodeID = endpoint.id;
	}

	/**
	 * Set params of context
	 *
	 * @param {Object} newParams
	 * @param {Boolean} cloning
	 *
	 * @memberof Context
	 */
	setParams(newParams, cloning = false) {
		if (cloning && newParams)
			this.params = Object.assign({}, newParams);
		else
			this.params = newParams;
	}

	/**
	 * Call an other action. It creates a sub-context.
	 *
	 * @param {String} actionName
	 * @param {Object?} params
	 * @param {Object?} opts
	 * @returns {Promise}
	 *
	 * @example <caption>Call an other service with params & options</caption>
	 * ctx.call("posts.get", { id: 12 }, { timeout: 1000 });
	 *
	 * @memberof Context
	 */
	call(actionName, params, _opts) {
		const opts = Object.assign({
			parentCtx: this
		}, _opts);

		if (this.options.timeout > 0 && this.startHrTime) {
			// Distributed timeout handling. Decrementing the timeout value with the elapsed time.
			// If the timeout below 0, skip the call.
			const diff = process.hrtime(this.startHrTime);
			const duration = (diff[0] * 1e3) + (diff[1] / 1e6);
			const distTimeout = this.options.timeout - duration;

			if (distTimeout <= 0) {
				return Promise.reject(new RequestSkippedError({ action: actionName, nodeID: this.broker.nodeID }));
			}

			if (!opts.timeout || distTimeout < opts.timeout)
				opts.timeout = distTimeout;
		}

		// Max calling level check to avoid calling loops
		if (this.broker.options.maxCallLevel > 0 && this.level >= this.broker.options.maxCallLevel) {
			return Promise.reject(new MaxCallLevelError({ nodeID: this.broker.nodeID, level: this.level }));
		}

		let p = this.broker.call(actionName, params, opts);

		// Merge metadata with sub context metadata
		return p.then(res => {
			if (p.ctx)
				mergeMeta(this, p.ctx.meta);

			return res;
		}).catch(err => {
			if (p.ctx)
				mergeMeta(this, p.ctx.meta);

			return Promise.reject(err);
		});
	}

	/**
	 * Emit an event (grouped & balanced global event)
	 *
	 * @param {string} eventName
	 * @param {any?} payload
	 * @param {Object?} groups
	 * @returns
	 *
	 * @example
	 * ctx.emit("user.created", { entity: user, creator: ctx.meta.user });
	 *
	 * @memberof Context
	 */
	emit(eventName, data, opts) {
		if (Array.isArray(opts) || _.isString(opts))
			opts = { groups: opts };
		else if (opts == null)
			opts = {};

		if (opts.groups && !Array.isArray(opts.groups))
			opts.groups = [opts.groups];

		opts.parentCtx = this;
		return this.broker.emit(eventName, data, opts);
	}

	/**
	 * Emit an event for all local & remote services
	 *
	 * @param {string} eventName
	 * @param {any?} payload
	 * @param {Object?} groups
	 * @returns
	 *
	 * @example
	 * ctx.broadcast("user.created", { entity: user, creator: ctx.meta.user });
	 *
	 * @memberof Context
	 */
	broadcast(eventName, data, opts) {
		if (Array.isArray(opts) || _.isString(opts))
			opts = { groups: opts };
		else if (opts == null)
			opts = {};

		if (opts.groups && !Array.isArray(opts.groups))
			opts.groups = [opts.groups];

		opts.parentCtx = this;
		return this.broker.broadcast(eventName, data, opts);
	}

	/**
	 * Start a new child tracing span.
	 *
	 * @param {String} name
	 * @param {Object?} opts
	 * @returns {Span}
	 * @memberof Context
	 */
	startSpan(name, opts) {
		if (this.span) {
			this.span = this.span.startSpan(name, opts);
		} else {
			this.span = this.broker.tracer.startSpan(name, opts);
		}

		return this.span;
	}

	/**
	 * Convert Context to a printable POJO object.
	 */
	toJSON() {
		const res = _.pick(this, [
			"nodeID",
			"action.name",
			"event.name",
			"service.name",
			"service.version",
			"service.fullName",
			"options",
			"parentID",
			"caller",
			"level",
			"params",
			"meta",
			"requestID",
			"tracing",
			"span",
			"needAck",
			"ackID",
			"eventName",
			"eventType",
			"eventGroups",
			"cachedResult"
		]);

		res.id = this._id ? this._id : null;
		return res;
	}

	/* istanbul ignore next */
	[util.inspect.custom](depth, options) {
		// https://nodejs.org/docs/latest-v8.x/api/util.html#util_custom_inspection_functions_on_objects
		if (depth < 0) {
			return options.stylize("[Context]", "special");
		}

		const inner = util.inspect(this.toJSON(), options);
		return `${options.stylize("Context", "special")}< ${inner} >`;
	}
}

module.exports = Context;
