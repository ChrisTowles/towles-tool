import { Schema } from "effect";
import { list } from "@/lib/schemas/shape";

/** Runtime validators for the Slack DM panel (`lib/slack.ts`) — payloads that
 * originate from the external Slack Web API, one layer further from our own
 * control than an internal command result. */

const DmFileSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimetype: Schema.String,
  urlPrivate: Schema.String,
  thumbUrl: Schema.String,
  permalink: Schema.String,
  isImage: Schema.Boolean,
});

const DmReactionSchema = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
  mine: Schema.Boolean,
});

const DmMessageSchema = Schema.Struct({
  tsRaw: Schema.String,
  text: Schema.String,
  ts: Schema.Number,
  fromMe: Schema.Boolean,
  files: list(DmFileSchema),
  reactions: list(DmReactionSchema),
  threadTs: Schema.String,
  replyCount: Schema.Number,
  latestReplyTs: Schema.Number,
});

export const SlackDmViewSchema = Schema.Struct({
  configured: Schema.Boolean,
  watchName: Schema.String,
  watchUserId: Schema.String,
  messages: list(DmMessageSchema),
});

export const SlackThreadSchema = list(DmMessageSchema);

export const SlackFileDataSchema = Schema.Struct({
  mimetype: Schema.String,
  dataBase64: Schema.String,
});
