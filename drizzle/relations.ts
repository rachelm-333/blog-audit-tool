import { relations } from "drizzle-orm";
import {
  businesses,
  cmsConnections,
  creditTransactions,
  iauditUsers,
  posts,
} from "./schema";

// iaudit_users → businesses (one user has many businesses)
export const iauditUsersRelations = relations(iauditUsers, ({ many }) => ({
  businesses: many(businesses),
  creditTransactions: many(creditTransactions),
}));

// businesses → iaudit_users (each business belongs to one user)
// businesses → cms_connections (one business has many CMS connections)
// businesses → posts (one business has many posts)
export const businessesRelations = relations(businesses, ({ one, many }) => ({
  user: one(iauditUsers, {
    fields: [businesses.userId],
    references: [iauditUsers.id],
  }),
  cmsConnections: many(cmsConnections),
  posts: many(posts),
}));

// cms_connections → businesses
export const cmsConnectionsRelations = relations(cmsConnections, ({ one }) => ({
  business: one(businesses, {
    fields: [cmsConnections.businessId],
    references: [businesses.id],
  }),
}));

// posts → businesses
export const postsRelations = relations(posts, ({ one }) => ({
  business: one(businesses, {
    fields: [posts.businessId],
    references: [businesses.id],
  }),
}));

// credit_transactions → iaudit_users
// credit_transactions → posts (optional)
export const creditTransactionsRelations = relations(
  creditTransactions,
  ({ one }) => ({
    user: one(iauditUsers, {
      fields: [creditTransactions.userId],
      references: [iauditUsers.id],
    }),
    post: one(posts, {
      fields: [creditTransactions.postId],
      references: [posts.id],
    }),
  })
);
