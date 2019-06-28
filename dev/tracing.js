"use strict";

const asyncHooks = require("async_hooks");
/*
const tracer = require("dd-trace").init({
	service: "moleculer", // shows up as Service in Datadog UI
	//url: "http://192.168.0.181:8126",
	debug: true,
	samplingPriority: "USER_KEEP",
});

tracer.use("http");
tracer.use("ioredis");
*/

const ServiceBroker = require("../src/service-broker");
"use strict";

const { MoleculerError } 	= require("../src/errors");
const _ 					= require("lodash");
const { inspect }			= require("util");

const THROW_ERR = false;

// Create broker
const broker = new ServiceBroker({
	nodeID: "node-1",
	logger: console,
	logLevel: "info",
	logObjectPrinter: o => inspect(o, { showHidden: false, depth: 4, colors: true, breakLength: 50 }),
	//transporter: "redis://localhost:6379",
	cacher: "redis://localhost:6379",

	tracing: {
		events: true,
		stackTrace: true,
		sampling: {
			rate: 1,
			//tracesPerSecond: 1
		},
		exporter: [
			{
				type: "Console",
				options: {
					width: 100,
					gaugeWidth: 30,
					logger: console.info
				}
			},
			/*{
				type: "Datadog",
				options: {
					tracer,
					samplingPriority: "USER_KEEP"
				}
			},*/
			/*{
				type: "Zipkin",
				options: {
					baseURL: "http://192.168.0.181:9411",
				}
			},*/
			{
				type: "Jaeger",
				options: {
					host: "192.168.0.181",
				}
			},
			/*{
				type: "Event",
				options: {
				}
			}*/
			/*{
				type: "EventLegacy"
			}*/
		]
	}
});

const POSTS = [
	{ id: 1, title: "First post", content: "Content of first post", author: 2 },
	{ id: 2, title: "Second post", content: "Content of second post", author: 1 },
	{ id: 3, title: "3rd post", content: "Content of 3rd post", author: 2 },
];

broker.createService({
	name: "posts",
	actions: {
		sync: {
			async handler(ctx) {
				const span1 = ctx.startSpan("span-1");

				const span2 = ctx.startSpan("span-1-2");

				const span21 = ctx.startSpan("span-1-2-1");
				await this.Promise.delay(10);
				span21.finish();

				const span22 = ctx.startSpan("span-1-2-2");
				span22.finish();

				span2.finish();

				const span3 = ctx.startSpan("span-1-3");

				const span31 = ctx.startSpan("span-1-3-1");
				await this.Promise.delay(10);
				span31.finish();

				const span32 = ctx.startSpan("span-1-3-2");
				span32.finish();

				span3.finish();

				span1.finish();
			}
		},

		find: {
			//cache: true,
			async handler(ctx) {
				const span1 = ctx.startSpan("cloning posts");
				const posts = _.cloneDeep(POSTS);
				const something = await this.broker.cacher.get("something");
				span1.finish();

				const span2 = ctx.startSpan("populate posts");
				//await this.Promise.delay(10);
				const res = await this.Promise.map(posts, async post => {
					const span3 = span2.startSpan("populate #" + post.id, { tags: {
						id: post.id
					} });
					//await this.Promise.delay(15);

					span2.log("Populating", { postID: post.id });

					const res = await this.Promise.all([
						ctx.call("users.get", { id: post.author }).then(author => post.author = author),
						ctx.call("votes.count", { postID: post.id }).then(votes => post.votes = votes),
					]);

					span3.finish();

					//return res;
				}, { concurrency: 1 });

				span2.finish();
				return posts;
			}
		}
	}
});

const USERS = [
	{ id: 1, name: "John Doe" },
	{ id: 2, name: "Jane Doe" },
];

broker.createService({
	name: "users",
	actions: {
		get: {
			tracing: {
				tags: {
					params: ["id"],
					meta: ["loggedIn.username"],
					response: ["friends"]
				}
			},
			cache: {
				enabled: true,
				ttl: 5
			},
			async handler(ctx) {
				ctx.emit("user.access", ctx.params.id);
				const user = USERS.find(user => user.id == ctx.params.id);
				if (user) {
					const res = _.cloneDeep(user);
					res.friends = await ctx.call("friends.count", { userID: user.id });
					return res;
				}
			}
		}
	}
});

broker.createService({
	name: "votes",
	actions: {
		count: {
			tracing: {
				tags: ctx => {
					return {
						params: ctx.params,
						meta: ctx.meta,
						custom: {
							a: 5
						}
					};
				}
			},
			async handler(ctx) {
				const span1 = ctx.startSpan("Fake delay");
				//await this.Promise.delay(10 + _.random(30));
				span1.finish();
				return ctx.params.postID * 3;
			}
		}
	}
});

broker.createService({
	name: "friends",
	actions: {
		count: {
			tracing: true,
			async handler(ctx) {
				if (THROW_ERR && ctx.params.userID == 1)
					throw new MoleculerError("Friends is not found!", 404, "FRIENDS_NOT_FOUND", { userID: ctx.params.userID });

				await this.Promise.delay(_.random(10));
				return ctx.params.userID * 3;
			}
		}
	}
});

broker.createService({
	name: "followers",
	actions: {
		count: {
			tracing: true,
			async handler(ctx) {
				await this.Promise.delay(_.random(50));
				return Math.round(Math.random() * 10);
			}
		}
	}
});

broker.createService({
	name: "event-handler",
	events: {
		"$tracing.spans"(payload) {
			this.logger.info("Tracing event received", payload);
		},
		"metrics.trace.span.start"(payload) {
			this.logger.info("Legacy tracing start event received");
		},
		"metrics.trace.span.finish"(payload) {
			this.logger.info("Legacy tracing finish event received", payload);
		},
		"user.access": {
			tracing: true,
			async handler(payload) {
				this.logger.info("User access event received. It is sampled in tracing!");
				const span = this.broker.tracer.startSpan("work in event");
				//await this.Promise.delay(10);
				await this.broker.call("followers.count");
				span.finish();
			}
		}
	}
});

broker.createService({
	name: "api",
	actions: {
		rest: {
			handler(ctx) {
				return ctx.call(ctx.params.action, ctx.params.params);
			}
		}
	},
	created() {
		const http = require("http");
		this.server = http.createServer();
		this.server.on("request", async (req, res) => {
			try {
				const data = await this.broker.call("api.rest", {
					action: "posts.find"
				});
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify(data));
			} catch(err) {
				res.statusCode = 500;
				res.end(err.message);
			}
		});
	},

	started() {
		this.server.listen(3000);
	},

	stopped() {
		this.server.close();
	}
});

// Start server
broker.start().then(() => {
	broker.repl();

	// Call action
	//setInterval(() => {
	broker
		.call("posts.find", { limit: 5 }, { meta: { loggedIn: { username: "Adam" } } })
		//.then(console.log)
		.catch(console.error);

	//}, 5000);
});
