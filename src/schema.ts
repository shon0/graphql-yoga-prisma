import { GraphQLError } from 'graphql'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { Prisma, Link, Comment, User } from '@prisma/client'
import { hash, compare } from 'bcryptjs'
import { sign } from 'jsonwebtoken'
import { APP_SECRET } from './auth'
import type { GraphQLContext } from './context'

const typeDefinitions = `
  type Query {
    info: String!
    feed(filterNeedle: String, skip: Int, take: Int): [Link!]!
    comment(id: ID!): Comment
    link(id: ID): Link
    me: User!
  }

  type Mutation {
    postLink(url: String!, description: String!): Link!
    postCommentOnLink(linkId: ID!, body: String!): Comment!
    signup(email: String!, password: String!, name: String!): AuthPayload
    login(email: String!, password: String!): AuthPayload
  }

  type Link {
    id: ID!
    description: String!
    url: String!
    comments: [Comment!]!
    postedBy: User
  }

  type Comment {
    id: ID!
    body: String!
    link: Link
  }

  type AuthPayload {
    token: String
    user: User
  }

  type User {
    id: ID!
    name: String!
    email: String!
    links: [Link!]!
  }
`

const parseIntSafe = (value: string): number | null => {
  if (/^(\d+)$/.test(value)) {
    return parseInt(value, 10)
  }
  return null
}

const applyTakeConstraints = (params: {
  min: number
  max: number
  value: number
}) => {
  if (params.value < params.min || params.value > params.max) {
    throw new GraphQLError(
      `'take' argument value '${params.value}' is outside the valid range of '${params.min}' to '${params.max}'.`
    )
  }
  return params.value
}

const resolvers = {
  Query: {
    info: () => `This is the API of a Hackernews Clone`,
    feed: async (
      parent: unknown,
      args: { filterNeedle?: string; skip?: number; take?: number },
      context: GraphQLContext
    ) => {
      const where = args.filterNeedle
        ? {
            OR: [
              { description: { contains: args.filterNeedle } },
              { url: { contains: args.filterNeedle } },
            ],
          }
        : {}

      const take = applyTakeConstraints({
        min: 1,
        max: 50,
        value: args.take ?? 30,
      })

      return context.prisma.link.findMany({
        where,
        skip: args.skip,
        take,
      })
    },
    async comment(
      parent: unknown,
      args: { id: string },
      context: GraphQLContext
    ) {
      return context.prisma.comment.findUnique({
        where: { id: parseInt(args.id) },
      })
    },
    async link(parent: unknown, args: { id: string }, context: GraphQLContext) {
      return context.prisma.link.findUnique({
        where: { id: parseInt(args.id) },
      })
    },
    me(parent: unknown, args: {}, context: GraphQLContext) {
      if (context.currentUser === null) {
        throw new Error('Unauthenticated!')
      }

      return context.currentUser
    },
  },
  Link: {
    id: (parent: Link) => parent.id,
    description: (parent: Link) => parent.description,
    url: (parent: Link) => parent.url,
    comments(parent: Link, args: {}, context: GraphQLContext) {
      return context.prisma.comment.findMany({
        where: {
          linkId: parent.id,
        },
      })
    },
    postedBy(parent: Link, args: {}, context: GraphQLContext) {
      if (!parent.postedById) {
        return null
      }

      return context.prisma.link
        .findUnique({ where: { id: parent.id } })
        .postedBy()
    },
  },
  Comment: {
    id: (parent: Comment) => parent.id,
    body: (parent: Comment) => parent.body,
    link(parent: Comment, args: {}, context: GraphQLContext) {
      if (parent.linkId === null) return null

      return context.prisma.link.findUnique({
        where: {
          id: parent.linkId,
        },
      })
    },
  },
  User: {
    id: (parent: User) => parent.id,
    name: (parent: User) => parent.name,
    email: (parent: User) => parent.email,
    links: (parent: User, args: {}, context: GraphQLContext) =>
      context.prisma.user.findUnique({ where: { id: parent.id } }).links(),
  },
  Mutation: {
    async postLink(
      parent: unknown,
      args: { description: string; url: string },
      context: GraphQLContext
    ) {
      if (context.currentUser === null) {
        throw new Error('Unauthenticated!')
      }

      if (args.description === '') {
        return Promise.reject(
          new GraphQLError(`Cannot post link with empty description.`)
        )
      }

      if (args.url === '') {
        return Promise.reject(
          new GraphQLError(`Cannot post link with empty url.`)
        )
      }

      const newLink = await context.prisma.link.create({
        data: {
          url: args.url,
          description: args.description,
          postedBy: { connect: { id: context.currentUser.id } },
        },
      })
      return newLink
    },
    async postCommentOnLink(
      parent: unknown,
      args: { linkId: string; body: string },
      context: GraphQLContext
    ) {
      const linkId = parseIntSafe(args.linkId)
      if (linkId === null) {
        return Promise.reject(
          new GraphQLError(
            `Cannot post comment on non-existing link with id '${args.linkId}'.`
          )
        )
      }

      if (args.body === '') {
        return Promise.reject(new GraphQLError(`Cannot post empty comment.`))
      }

      const newComment = await context.prisma.comment
        .create({
          data: {
            body: args.body,
            linkId: parseInt(args.linkId),
          },
        })
        .catch((err: unknown) => {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2003'
          ) {
            return Promise.reject(
              new GraphQLError(
                `Cannot post comment on non-existing link with id '${args.linkId}'.`
              )
            )
          }
          return Promise.reject(err)
        })

      return newComment
    },
    async signup(
      parent: unknown,
      args: { email: string; password: string; name: string },
      context: GraphQLContext
    ) {
      const password = await hash(args.password, 10)

      const user = await context.prisma.user.create({
        data: { ...args, password },
      })

      const token = sign({ userId: user.id }, APP_SECRET)

      return { token, user }
    },
    async login(
      parent: unknown,
      args: { email: string; password: string },
      context: GraphQLContext
    ) {
      const user = await context.prisma.user.findUnique({
        where: { email: args.email },
      })
      if (!user) {
        throw new Error('No such user found')
      }

      const valid = await compare(args.password, user.password)
      if (!valid) {
        throw new Error('Invalid password')
      }

      const token = sign({ userId: user.id }, APP_SECRET)

      return { token, user }
    },
  },
}

export const schema = makeExecutableSchema({
  resolvers: [resolvers],
  typeDefs: [typeDefinitions],
})
