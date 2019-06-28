"use strict";

const asyncHooks			= require("async_hooks");

//jest.mock("dd-trace");
jest.mock("dd-trace/packages/dd-trace/src/opentracing/span_context");
//jest.mock("dd-trace/src/platform");

const ddTrace = require("dd-trace");
const DatadogSpanContext = require("dd-trace/packages/dd-trace/src/opentracing/span_context");
const DatadogPlatform = require("dd-trace/packages/dd-trace/src/platform");

const fakeTracerScope = {
	_spans: {},
	_destroy: jest.fn(),
	active: jest.fn(() => fakeDdSpan)
};

const fakeSpanContext = {
	toTraceId: jest.fn(() => "trace-id"),
	toSpanId: jest.fn(() => "span-id")
};

const fakeDdSpan = {
	log: jest.fn(),
	setTag: jest.fn(),
	context: jest.fn(() => fakeSpanContext),
	finish: jest.fn()
};

const fakeDdTracer = {
	scope: jest.fn(() => fakeTracerScope),
	startSpan: jest.fn(() => fakeDdSpan)
};

DatadogSpanContext.mockImplementation(opts => opts);

const DatadogTraceExporter = require("../../../../src/tracing/exporters/datadog");
const ServiceBroker = require("../../../../src/service-broker");
const Tracer = require("../../../../src/tracing/tracer");
const { MoleculerRetryableError } = require("../../../../src/errors");

const broker = new ServiceBroker({ logger: false });

describe("Test Datadog tracing exporter class", () => {

	describe("Test Constructor", () => {

		it("should create with default options", () => {
			const exporter = new DatadogTraceExporter();

			expect(exporter.opts).toEqual({
				agentUrl: process.env.DD_AGENT_URL || "http://localhost:8126",
				env: process.env.DD_ENVIRONMENT || null,
				samplingPriority: "AUTO_KEEP",
				defaultTags: null,
				tracerOptions: null,
			});

			expect(exporter.ddTracer).toBeUndefined();
		});

		it("should create with custom options", () => {
			const fakeDdTracer = {};

			const exporter = new DatadogTraceExporter({
				tracer: fakeDdTracer,
				agentUrl: "http://datadog-agent:8126",
				env: "testing",
				samplingPriority: "USER_KEEP",
				tracerOptions: {
					b: 10
				},

				defaultTags: {
					c: 15
				}
			});

			expect(exporter.opts).toEqual({
				tracer: fakeDdTracer,
				agentUrl: "http://datadog-agent:8126",
				env: "testing",
				samplingPriority: "USER_KEEP",
				tracerOptions: {
					b: 10
				},

				defaultTags: {
					c: 15
				}
			});

			expect(exporter.ddTracer).toBe(fakeDdTracer);
		});

	});

	describe("Test init method", () => {
		const fakeTracer = {
			logger: broker.logger,
			getCurrentTraceID: jest.fn(),
			getActiveSpanID: jest.fn(),
		};

		ddTrace.init = jest.fn(() => fakeDdTracer);

		it("should call ddTrace.init", () => {
			ddTrace.init.mockClear();

			const exporter = new DatadogTraceExporter({
				agentUrl: "https://agent:1234",
				tracerOptions: {
					a: 5
				}
			});
			exporter.init(fakeTracer);

			expect(exporter.ddTracer).toBe(fakeDdTracer);

			expect(ddTrace.init).toHaveBeenCalledTimes(1);
			expect(ddTrace.init).toHaveBeenCalledWith({
				url: "https://agent:1234",
				a: 5
			});
		});

		it("should not call ddTrace.init if tracer defined in options", () => {
			ddTrace.init.mockClear();

			const exporter = new DatadogTraceExporter({
				tracer: fakeDdTracer
			});
			exporter.init(fakeTracer);

			expect(exporter.ddTracer).toBe(fakeDdTracer);
			expect(ddTrace.init).toHaveBeenCalledTimes(0);
		});

		it("should wrap the getCurrentTraceID & getActiveSpanID methods of tracer", () => {
			ddTrace.init.mockClear();

			const oldGetCurrentTraceID = fakeTracer.getCurrentTraceID;
			const oldGetActiveSpanID = fakeTracer.getActiveSpanID;

			const exporter = new DatadogTraceExporter();
			exporter.init(fakeTracer);

			expect(fakeTracer.getCurrentTraceID).not.toBe(oldGetCurrentTraceID);
			expect(fakeTracer.getActiveSpanID).not.toBe(oldGetActiveSpanID);
		});

		it("should flatten default tags", () => {
			const exporter = new DatadogTraceExporter({ defaultTags: { a: { b: "c" } } });
			jest.spyOn(exporter, "flattenTags");
			exporter.init(fakeTracer);

			expect(exporter.defaultTags).toEqual({
				"a.b": "c"
			});

			expect(exporter.flattenTags).toHaveBeenCalledTimes(2);
			expect(exporter.flattenTags).toHaveBeenNthCalledWith(1, { a: { b: "c" } }, true);
			expect(exporter.flattenTags).toHaveBeenNthCalledWith(2, { b: "c" }, true, "a");
		});

		it("should call defaultTags function", () => {
			const fn = jest.fn(() => ({ a: { b: 5 } }));
			const exporter = new DatadogTraceExporter({ defaultTags: fn });
			exporter.init(fakeTracer);

			expect(exporter.defaultTags).toEqual({
				"a.b": "5"
			});

			expect(fn).toHaveBeenCalledTimes(1);
			expect(fn).toHaveBeenNthCalledWith(1, fakeTracer);
		});

	});

	describe("Test startSpan method", () => {
		const fakeTracer = {
			logger: broker.logger,
			opts: {
				errorFields: ["name", "message", "retryable", "data", "code"]
			},
			getCurrentTraceID: jest.fn(),
			getActiveSpanID: jest.fn(),
		};
		const exporter = new DatadogTraceExporter({
			defaultTags: {
				"def": "ault"
			}
		});
		exporter.init(fakeTracer);

		it("should convert normal span to Datadog span without parentID", () => {
			const span = {
				name: "Test Span",
				id: "abc-12345678901234567890",
				type: "custom",
				traceID: "cde-12345678901234567890",
				//parentID: "def-12345678901234567890",

				service: {
					fullName: "v1.posts"
				},

				startTime: 1000,
				finishTime: 1050,
				duration: 50,

				tags: {
					a: 5,
					b: "John",
					c: true,
					d: null
				},

				meta: {}
			};

			exporter.startSpan(span);

			expect(exporter.ddTracer.startSpan).toHaveBeenCalledTimes(1);
			expect(exporter.ddTracer.startSpan).toHaveBeenCalledWith("Test Span", {
				startTime: 1000,
				childOf: undefined,
				tags: {
					a: 5,
					b: "John",
					c: true,
					d: null,
					def: "ault",
					"service.fullName": "v1.posts",

					type: "custom",
					resource: undefined,
					"sampling.priority": "AUTO_KEEP",
					"span.kind": "server",
					"span.type": "custom"
				}
			});

			expect(fakeDdSpan.setTag).toHaveBeenCalledTimes(1);
			expect(fakeDdSpan.setTag).toHaveBeenCalledWith("service", "v1.posts");

			expect(fakeDdSpan.context).toHaveBeenCalledTimes(1);

			expect(fakeSpanContext._traceId).toBeInstanceOf(DatadogPlatform.Uint64BE);
			expect(fakeSpanContext._spanId).toBeInstanceOf(DatadogPlatform.Uint64BE);

			expect(fakeSpanContext._traceId.toString()).toEqual("14835177428531872035");
			expect(fakeSpanContext._spanId.toString()).toEqual("12376212031987581219");

			expect(span.meta.datadog).toEqual({
				span: fakeDdSpan,
				asyncId: asyncHooks.executionAsyncId(),
				oldSpan: undefined
			});

		});

		it("should convert normal span to Datadog span with parentID, env & logs", () => {
			exporter.ddTracer.startSpan.mockClear();
			fakeDdSpan.context.mockClear();
			fakeDdSpan.setTag.mockClear();
			DatadogSpanContext.mockClear();
			exporter.convertID = jest.fn(id => id);
			exporter.opts.env = "testing";

			const fakeOldSpan = { name: "old-span" };
			fakeTracerScope._spans[asyncHooks.executionAsyncId()] = fakeOldSpan;

			const span = {
				name: "Test Span",
				type: "action",
				id: "aaa-12345678901234567890",
				traceID: "bbb-12345678901234567890",
				parentID: "ccc-12345678901234567890",

				service: {
					fullName: "v1.posts"
				},

				startTime: 1000,
				finishTime: 1050,
				duration: 50,

				tags: {
					a: 5,
					b: "John",
					c: true,
					d: null
				},

				logs: [
					{ name: "log1", time: 100, fields: { a: 5 } },
					{ name: "log2", time: 200, fields: { b: "John" } },
				],

				meta: {}
			};

			exporter.startSpan(span);

			expect(exporter.ddTracer.startSpan).toHaveBeenCalledTimes(1);
			expect(exporter.ddTracer.startSpan).toHaveBeenCalledWith("Test Span", {
				startTime: 1000,
				childOf: {
					parentId: "ccc-12345678901234567890",
					spanId: "ccc-12345678901234567890",
					traceId: "bbb-12345678901234567890",
				},
				tags: {
					a: 5,
					b: "John",
					c: true,
					d: null,
					def: "ault",
					"service.fullName": "v1.posts",

					type: "action",
					resource: undefined,
					"sampling.priority": "AUTO_KEEP",
					"span.kind": "server",
					"span.type": "action"
				}
			});

			expect(fakeDdSpan.setTag).toHaveBeenCalledTimes(2);
			expect(fakeDdSpan.setTag).toHaveBeenNthCalledWith(1,"env", "testing");
			expect(fakeDdSpan.setTag).toHaveBeenNthCalledWith(2,"service", "v1.posts");

			expect(fakeDdSpan.context).toHaveBeenCalledTimes(1);

			expect(DatadogSpanContext).toHaveBeenCalledTimes(1);
			expect(DatadogSpanContext).toHaveBeenCalledWith({
				parentId: "ccc-12345678901234567890",
				spanId: "ccc-12345678901234567890",
				traceId: "bbb-12345678901234567890",
			});

			expect(fakeSpanContext._traceId.toString()).toEqual("bbb-12345678901234567890");
			expect(fakeSpanContext._spanId.toString()).toEqual("aaa-12345678901234567890");

			expect(span.meta.datadog).toEqual({
				span: fakeDdSpan,
				asyncId: asyncHooks.executionAsyncId(),
				oldSpan: fakeOldSpan
			});
		});
	});

	describe("Test finishSpan method", () => {
		const fakeTracer = {
			logger: broker.logger,
			opts: {
				errorFields: ["name", "message", "retryable", "data", "code"]
			},
			getCurrentTraceID: jest.fn(),
			getActiveSpanID: jest.fn(),
		};
		const exporter = new DatadogTraceExporter({
			defaultTags: {
				"def": "ault"
			}
		});
		exporter.init(fakeTracer);

		it("should finish", () => {
			fakeDdSpan.finish.mockClear();
			exporter.addTags = jest.fn();
			exporter.addLogs = jest.fn();

			const span = {
				finishTime: 1050,

				logs: [1,5],

				meta: {
					datadog: {
						span: fakeDdSpan,
						asyncId: asyncHooks.executionAsyncId(),
						oldSpan: undefined
					}
				}
			};

			exporter.finishSpan(span);

			expect(exporter.addTags).toHaveBeenCalledTimes(0);

			expect(exporter.addLogs).toHaveBeenCalledTimes(1);
			expect(exporter.addLogs).toHaveBeenCalledWith(fakeDdSpan, span.logs);

			expect(fakeDdSpan.finish).toHaveBeenCalledTimes(1);
			expect(fakeDdSpan.finish).toHaveBeenCalledWith(1050);

			expect(fakeTracerScope._destroy).toHaveBeenCalledTimes(1);
			expect(fakeTracerScope._destroy).toHaveBeenCalledWith(span.meta.datadog.asyncId);
		});

		it("should finish with error", () => {
			fakeDdSpan.finish.mockClear();
			fakeTracerScope._destroy.mockClear();
			exporter.addTags = jest.fn();
			exporter.addLogs = jest.fn();

			const fakeOldSpan = { name: "old-span" };
			fakeTracerScope._spans[asyncHooks.executionAsyncId()] = null;

			const err = new MoleculerRetryableError("Something happened", 512, "SOMETHING", { a: 5 });

			const span = {
				finishTime: 1050,

				logs: [],

				error: err,

				meta: {
					datadog: {
						span: fakeDdSpan,
						asyncId: asyncHooks.executionAsyncId(),
						oldSpan: fakeOldSpan
					}
				}
			};

			exporter.finishSpan(span);

			expect(exporter.addTags).toHaveBeenCalledTimes(1);
			expect(exporter.addTags).toHaveBeenCalledWith(fakeDdSpan, "error", {
				name: "MoleculerRetryableError",
				code: 512,
				data: { "a": 5 },
				message: "Something happened",
				retryable: true
			});

			expect(exporter.addLogs).toHaveBeenCalledTimes(1);
			expect(exporter.addLogs).toHaveBeenCalledWith(fakeDdSpan, span.logs);

			expect(fakeDdSpan.finish).toHaveBeenCalledTimes(1);
			expect(fakeDdSpan.finish).toHaveBeenCalledWith(1050);

			expect(fakeTracerScope._spans[asyncHooks.executionAsyncId()]).toBe(fakeOldSpan);

			expect(fakeTracerScope._destroy).toHaveBeenCalledTimes(0);
		});
	});

	describe("Test addLogs method", () => {
		const fakeTracer = {
			logger: broker.logger,
			getCurrentTraceID: jest.fn(),
			getActiveSpanID: jest.fn(),
		};

		const exporter = new DatadogTraceExporter();
		exporter.init(fakeTracer);

		it("should call span.log method", () => {
			const datadogSpan = {
				log: jest.fn()
			};

			exporter.addLogs(datadogSpan, [
				{ name: "log1", time: 100, fields: { a: 5 } },
				{ name: "log2", time: 200, fields: { b: "John" } },
			]);

			expect(datadogSpan.log).toHaveBeenCalledTimes(2);
			expect(datadogSpan.log).toHaveBeenNthCalledWith(1, { event: "log1", payload: { a: 5 } }, 100);
			expect(datadogSpan.log).toHaveBeenNthCalledWith(2, { event: "log2", payload: { b: "John" } }, 200);
		});

	});

	describe("Test addTags method", () => {
		const fakeTracer = {
			logger: broker.logger,
			getCurrentTraceID: jest.fn(),
			getActiveSpanID: jest.fn(),
		};

		const exporter = new DatadogTraceExporter();
		exporter.init(fakeTracer);

		const datadogSpan = {
			setTag: jest.fn()
		};

		it("should call span.setTag method with a numeric value", () => {
			datadogSpan.setTag.mockClear();

			exporter.addTags(datadogSpan, "a", 5);

			expect(datadogSpan.setTag).toHaveBeenCalledTimes(1);
			expect(datadogSpan.setTag).toHaveBeenCalledWith("a", 5);
		});

		it("should call span.setTag method with a string value", () => {
			datadogSpan.setTag.mockClear();

			exporter.addTags(datadogSpan, "b", "John");

			expect(datadogSpan.setTag).toHaveBeenCalledTimes(1);
			expect(datadogSpan.setTag).toHaveBeenCalledWith("b", "John");
		});

		it("should call span.setTag method with null", () => {
			datadogSpan.setTag.mockClear();

			exporter.addTags(datadogSpan, "c", null);

			expect(datadogSpan.setTag).toHaveBeenCalledTimes(1);
			expect(datadogSpan.setTag).toHaveBeenCalledWith("c", null);
		});

		it("should not call span.setTag method with null", () => {
			datadogSpan.setTag.mockClear();

			exporter.addTags(datadogSpan, "c", undefined);

			expect(datadogSpan.setTag).toHaveBeenCalledTimes(0);
		});

		it("should call span.setTag method with object", () => {
			datadogSpan.setTag.mockClear();

			exporter.addTags(datadogSpan, "user", {
				id: 1,
				name: "John",
				address: {
					country: "Australia",
					city: "Sydney"
				}
			});

			expect(datadogSpan.setTag).toHaveBeenCalledTimes(4);
			expect(datadogSpan.setTag).toHaveBeenNthCalledWith(1, "user.id", 1);
			expect(datadogSpan.setTag).toHaveBeenNthCalledWith(2, "user.name", "John");
			expect(datadogSpan.setTag).toHaveBeenNthCalledWith(3, "user.address.country", "Australia");
			expect(datadogSpan.setTag).toHaveBeenNthCalledWith(4, "user.address.city", "Sydney");
		});

	});

	describe("Test convertID method", () => {
		const fakeTracer = {
			logger: broker.logger,
			getCurrentTraceID: jest.fn(),
			getActiveSpanID: jest.fn(),
		};
		const exporter = new DatadogTraceExporter({});
		exporter.init(fakeTracer);

		it("should truncate ID", () => {
			expect(exporter.convertID()).toBeNull();
			expect(exporter.convertID("")).toBeNull();
			expect(exporter.convertID("12345678").toString()).toEqual("12345678");
			expect(exporter.convertID("123456789-0123456").toString()).toEqual("1311768467284833366");
			expect(exporter.convertID("123456789-0123456789-abcdef").toString()).toEqual("1311768467284833366");
			expect(exporter.convertID("abc-def").toString()).toEqual("0");
			expect(exporter.convertID("abc-def-abc-def-abc-def").toString()).toEqual("12379814471884843981");
		});

	});

	describe("Test wrapped getCurrentTraceID method", () => {

		it("should retun with the original traceID", () => {
			let oldGetCurrentTraceID = jest.fn(() => "old-trace-id");
			const fakeTracer = {
				getCurrentTraceID: oldGetCurrentTraceID,
				getActiveSpanID: jest.fn(),
			};
			const exporter = new DatadogTraceExporter({});
			exporter.init(fakeTracer);

			const res = exporter.tracer.getCurrentTraceID();

			expect(res).toBe("old-trace-id");

			expect(oldGetCurrentTraceID).toHaveBeenCalledTimes(1);
		});

		it("should retun with the original traceID", () => {
			fakeDdSpan.context.mockClear();
			let oldGetCurrentTraceID = jest.fn();
			const fakeTracer = {
				getCurrentTraceID: oldGetCurrentTraceID,
				getActiveSpanID: jest.fn(),
			};
			const exporter = new DatadogTraceExporter({});
			exporter.init(fakeTracer);

			const res = exporter.tracer.getCurrentTraceID();

			expect(res).toBe("trace-id");

			expect(oldGetCurrentTraceID).toHaveBeenCalledTimes(1);

			expect(fakeTracerScope.active).toHaveBeenCalledTimes(1);
			expect(fakeDdSpan.context).toHaveBeenCalledTimes(1);
			expect(fakeSpanContext.toTraceId).toHaveBeenCalledTimes(1);
		});

	});

	describe("Test wrapped getActiveSpanID method", () => {

		it("should retun with the original spanID", () => {
			let oldGetActiveSpanID = jest.fn(() => "old-trace-id");
			const fakeTracer = {
				getActiveSpanID: oldGetActiveSpanID,
				getCurrentTraceID: jest.fn(),
			};
			const exporter = new DatadogTraceExporter({});
			exporter.init(fakeTracer);

			const res = exporter.tracer.getActiveSpanID();

			expect(res).toBe("old-trace-id");

			expect(oldGetActiveSpanID).toHaveBeenCalledTimes(1);
		});

		it("should retun with the original spanID", () => {
			fakeDdSpan.context.mockClear();
			fakeTracerScope.active.mockClear();

			let oldGetActiveSpanID = jest.fn();
			const fakeTracer = {
				getActiveSpanID: oldGetActiveSpanID,
				getCurrentTraceID: jest.fn(),
			};
			const exporter = new DatadogTraceExporter({});
			exporter.init(fakeTracer);

			const res = exporter.tracer.getActiveSpanID();

			expect(res).toBe("span-id");

			expect(oldGetActiveSpanID).toHaveBeenCalledTimes(1);

			expect(fakeTracerScope.active).toHaveBeenCalledTimes(1);
			expect(fakeDdSpan.context).toHaveBeenCalledTimes(1);
			expect(fakeSpanContext.toSpanId).toHaveBeenCalledTimes(1);
		});

	});

});
