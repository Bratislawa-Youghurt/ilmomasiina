import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import moment from "moment";
import { col, fn, Op, Order, WhereOptions } from "sequelize";

import type { AdminEventListResponse, EventListQuery, UserEventListResponse } from "@tietokilta/ilmomasiina-models";
import { adminEventListEventAttrs, eventListEventAttrs } from "@tietokilta/ilmomasiina-models/dist/attrs/event";
import { Event } from "../../models/event";
import { Quota } from "../../models/quota";
import { Signup } from "../../models/signup";
import { ascNullsFirst } from "../../models/util";
import createCache from "../../util/cache";
import { InitialSetupNeeded, isInitialSetupDone } from "../admin/users/createInitialUser";
import { StringifyApi } from "../utils";

function eventOrder(): Order {
  return [
    // events without signup (date=NULL) come first
    ["date", ascNullsFirst()],
    ["registrationEndDate", "ASC"],
    ["title", "ASC"],
    [Quota, "order", "ASC"],
  ];
}

export const eventsListForUserCached = createCache({
  maxAgeMs: 1000,
  maxPendingAgeMs: 2000,
  async get(options: { category?: string; since?: string }) {
    const { category, since } = options;
    // Default to 7 days ago
    const sinceDate = since ? new Date(since) : undefined;
    const filters: WhereOptions = {};
    if (category) {
      filters.category = category;
    }
    if (since && !Number.isNaN(sinceDate)) {
      filters.endDate = {
        [Op.gte]: sinceDate,
      };
    } else {
      filters[Op.or as any] = {
        // closed less than 7 days ago
        registrationEndDate: {
          [Op.gt]: moment().subtract(7, "days").toDate(),
        },
        // or happened less than 7 days ago
        date: {
          [Op.gt]: moment().subtract(7, "days").toDate(),
        },
        endDate: {
          [Op.gt]: moment().subtract(7, "days").toDate(),
        },
      };
    }
    const where = {
      ...filters,
    };

    const events = await Event.scope("user").findAll({
      attributes: eventListEventAttrs,
      where: { listed: true, ...where },
      // Include quotas of event and count of signups
      include: [
        {
          model: Quota,
          attributes: ["id", "title", "size", [fn("COUNT", col("quotas->signups.id")), "signupCount"]],
          include: [
            {
              model: Signup.scope("active"),
              required: false,
              attributes: [],
            },
          ],
        },
      ],
      group: [col("event.id"), col("quotas.id")],
      order: eventOrder(),
    });

    return events.map((event) => ({
      ...event.get({ plain: true }),
      quotas: event.quotas!.map((quota) => ({
        ...quota.get({ plain: true }),
        signupCount: Number(quota.signupCount),
      })),
    }));
  },
});

export async function getEventsListForUser(
  this: FastifyInstance<any, any, any, any, any>,
  request: FastifyRequest<{ Querystring: EventListQuery }>,
  reply: FastifyReply,
): Promise<UserEventListResponse> {
  // When the application hasn't been set up for the first time, throw an error.
  if (!this.initialSetupDone && !(await isInitialSetupDone())) {
    throw new InitialSetupNeeded("Initial setup of Ilmomasiina is needed.");
  }

  const res = await eventsListForUserCached({ category: request.query.category, since: request.query.since });
  reply.status(200);
  return res as StringifyApi<typeof res>;
}

export async function getEventsListForAdmin(
  request: FastifyRequest<{ Querystring: EventListQuery }>,
  reply: FastifyReply,
): Promise<AdminEventListResponse> {
  // Admin view also shows id, draft and listed fields.

  const events = await Event.findAll({
    attributes: adminEventListEventAttrs,
    where: request.query,
    // Include quotas of event and count of signups
    include: [
      {
        model: Quota,
        attributes: ["id", "title", "size", [fn("COUNT", col("quotas->signups.id")), "signupCount"]],
        include: [
          {
            model: Signup.scope("active"),
            required: false,
            attributes: [],
          },
        ],
      },
    ],
    group: [col("event.id"), col("quotas.id")],
    order: eventOrder(),
  });

  const res = events.map((event) => ({
    ...event.get({ plain: true }),
    quotas: event.quotas!.map((quota) => ({
      ...quota.get({ plain: true }),
      signupCount: Number(quota.signupCount!),
    })),
  }));

  reply.status(200);
  return res as StringifyApi<typeof res>;
}
