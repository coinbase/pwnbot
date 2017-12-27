var Promise = require('bluebird')
var AWS = require('aws-sdk')
var DynamoDB = Promise.promisifyAll(new AWS.DynamoDB())
var _ = require('lodash')
var qs = require('qs')
var moment = require('moment')
var post = Promise.promisify(require('request').post)

/// //////////
//  DynamoDB Wrapper
/// //////////

exports.putItemAsync = (item) => {
  return DynamoDB.putItemAsync(item)
}

exports.queryAsync = (query) => {
  return DynamoDB.queryAsync(query)
}

/// //////////
//  CREATE
/// //////////

exports.save_pwn_to_db = (pwn) => {
  var item = {
    Item: {
      'pwner': {
        S: pwn.pwner
      },
      'pwner_id': {
        S: pwn.pwner_id
      },
      'pwned': {
        S: pwn.pwned
      },
      'pwned_id': {
        S: pwn.pwned_id
      },
      'team_id': {
        S: pwn.team_id
      },
      'team_domain': {
        S: pwn.team_domain
      },
      'created_at': {
        S: pwn.created_at // iso8601
      },
      'expires_at': {
        S: pwn.expires_at // iso8601
      },
      'expires_at_time': {
        N: '' + pwn.expires_at_time // for ttl
      }
    },
    ReturnConsumedCapacity: 'NONE',
    TableName: 'pwnbot-pwned'
  }

  return exports.putItemAsync(item).then(() => {
    return pwn
  })
}

exports.create_pwn = (pwn) => {
  return exports.recent_pwn(pwn.team_id, pwn.pwned).then((recent_pwn) => {
    if (recent_pwn) {
      throw new Error(`User "${pwn.pwned}" pwned within the last 5 minutes. *Lock this computer!*`)
    }

    return exports.save_pwn_to_db(pwn)
  }).then(() => {
    return "Your Pwn is recorded. *Don't forget to lock this computer!*"
  })
}

/// //////////
//  GET
/// //////////

// returns true if the user was pwned in the last 5 mins
exports.recent_pwn = (team_id, pwned) => {
  var created = moment().subtract(5, 'minutes').utc().toISOString()

  var query = {
    ExpressionAttributeValues: {
      ':team': {
        S: team_id
      },
      ':created': {
        S: created
      },
      ':pwned': {
        S: pwned
      }
    },
    KeyConditionExpression: 'team_id = :team AND created_at > :created',
    FilterExpression: 'pwned = :pwned',
    TableName: 'pwnbot-pwned'
  }

  return exports.queryAsync(query).then((data) => {
    // return not empty
    return !_.isEmpty(data.Items)
  })
}

exports.item_to_pwn = (item) => {
  return {
    pwner: item.pwner.S,
    pwner_id: item.pwner_id.S,
    pwner_user_id: `<@${item.pwner_id.S}>`,

    pwned: item.pwned.S,
    pwned_id: item.pwned_id.S,
    pwned_user_id: `<@${item.pwned_id.S}>`,

    team_domain: item.team_domain.S,
    team_id: item.team_id.S,
    expires_at: item.expires_at.S,
    expires_at_time: item.expires_at_time.N,
    created_at: item.created_at.S
  }
}

exports.pwned_list = (items) => {
  var cm = _.countBy(items, 'pwned_user_id')
  return Object.keys(cm).sort((a, b) => cm[b] - cm[a]).map((x) => `${x} _(${cm[x]})_`)
}

exports.pwner_list = (items) => {
  var cm = _.countBy(items, 'pwner_user_id')
  return Object.keys(cm).sort((a, b) => cm[b] - cm[a]).map((x) => `${x} _(${cm[x]})_`)
}

exports.recent_list = (items) => {
  return _.sortBy(items, 'created_at').reverse().map((x) => {
    return `${x.pwner_user_id} pwned ${x.pwned_user_id} ${moment(x.created_at).fromNow()}`
  })
}

exports.data_table = (items) => {
  var recent = exports.recent_list(items).slice(0, 5)
  var pwned = exports.pwned_list(items).slice(0, 5)
  var pwner = exports.pwner_list(items).slice(0, 5)

  var messages = []
  messages.push('*The PWNED*')
  for (let i in pwned) {
    messages.push(`${parseInt(i) + 1}. ${pwned[i]}`)
  }
  messages.push('-----')
  messages.push('*The PWNERS*')
  for (let i in pwner) {
    messages.push(`${parseInt(i) + 1}. ${pwner[i]}`)
  }
  messages.push('-----')
  messages.push('*RECENT*')
  for (let i in recent) {
    messages.push(recent[i])
  }

  return messages.join('\n')
}

exports.get_pwns = (team_id) => {
  var query = {
    ExpressionAttributeValues: {
      ':v1': {
        S: team_id
      }
    },
    KeyConditionExpression: 'team_id = :v1',
    TableName: 'pwnbot-pwned'
  }

  return exports.queryAsync(query).then((data) => {
    var items = data.Items.map(exports.item_to_pwn)
    return exports.data_table(items)
  })
}

/// //////////
//  VALIDATIONS
/// //////////

exports.validate_str = (obj, name) => {
  if (!_.isString(obj[name])) {
    throw new Error(`No ${name} User "${obj.pwned}"`)
  }
}
// must be valid slack token
// user cannot pwn themselves
exports.validate_pwn = (pwn) => {
  // Security
  if (process.env.SLACK_TOKEN !== pwn.token) {
    throw new Error('Unauthorized Access')
  }

  if (pwn.action === 'CREATE') {
    exports.validate_str(pwn, 'pwned')
    exports.validate_str(pwn, 'pwned_id')
    exports.validate_str(pwn, 'pwner')
    exports.validate_str(pwn, 'pwner_id')

    if (pwn.pwned_id === pwn.pwner_id) {
      throw new Error('User cannot pwn themselves')
    }
  }

  return true
}

/// //////////
//  HANDLE
/// //////////
exports.build_pwn = (event) => {
  var raw_pwn = {}

  if (event.httpMethod === 'POST') {
    raw_pwn = qs.parse(event.body)
  } else {
    raw_pwn = event.queryStringParameters
  }

  var raw_pwner, pwner, pwner_id
  var expiry_hours, expires_at, created_at, expires_at_time
  var action = 'CREATE'

  // PWNER
  // the first argument in the sent command should be <@U0000ID|pwner_name>
  raw_pwner = _.trim(raw_pwn.text).split(' ', 2)[0]
  if (raw_pwner === '') {
    action = 'GET'
  } else {
    // Raw PWNER must fit into <@...|...> format or break
    var regex = /^<@(.*)\|(.*)>$/g
    var match = regex.exec(raw_pwner)
    if (match === null) {
      throw new Error('Your user name must be a real user @...')
    }
    pwner_id = match[1]
    pwner = match[2]
  }

  // DATES
  // default is 30 days
  expiry_hours = parseInt(process.env.EXPIRY_HOURS) || (24 * 30)
  expires_at = new Date((new Date()).setHours(new Date().getHours() + expiry_hours))
  created_at = new Date()

  created_at = created_at.toISOString()
  expires_at = expires_at.toISOString()
  expires_at_time = Math.floor(Date.parse(expires_at) / 1000)

  return {
    action: action,
    pwner: pwner,
    pwner_id: pwner_id,
    pwned: raw_pwn.user_name,
    pwned_id: raw_pwn.user_id,
    team_id: raw_pwn.team_id,
    team_domain: raw_pwn.team_domain,
    created_at: created_at,
    expires_at: expires_at,
    expires_at_time: expires_at_time,
    token: raw_pwn.token
  }
}

exports.build_responce_body = (text, error = false) => {
  return JSON.stringify({
    username: 'PwnBot',
    text: text
  })
}

// GET REQUEST
// {
//   "resource": "", path": "", "headers": {}, "requestContext": {}, "isBase64Encoded": false
//   "httpMethod": "GET",
//   "queryStringParameters": {
//     "user_id": "<PWNEDID>",
//     "text": "<PWNER>", # first arg must be <U0000ID|pwner_name> formatted
//     "user_name": "<PWNED>", PWNED
//     "team_domain": "<TEAMDOMAIN>",
//     "team_id": "<TEAMID>",
//     "command": "/pwn",
//     "token": "<TOKEN>"
//   },
//   "body": null
// }

// POST REQUEST
// {
//   "resource": "", path": "", "headers": {}, "requestContext": {}, "isBase64Encoded": false
//   "httpMethod": "POST",
//   "body": "token=<TOKEN>&team_id=<TEAMID>&team_domain=<TEAMDOMAIN>&user_id=<PWNEDID>&user_name=<PWNED>&command=%2Fpwn&text=<>",
//   "queryStringParameters": null
// }
exports.handle_pwn = (event, callback) => {
  return Promise.try(() => {
    return exports.build_pwn(event)
  }).then((pwn) => {
    exports.validate_pwn(pwn)
    if (pwn.action === 'GET') {
      return exports.get_pwns(pwn.team_id) // READ PWNS FOR TEAM ID
    } else {
      return exports.create_pwn(pwn) // CREATE PWN
    }
  }).then((response_text) => {
    var response = {
      statusCode: 200,
      headers: {},
      body: exports.build_responce_body(response_text)
    }

    callback(null, response)
  })
  .catch((e) => {
    console.log(e)
    // Catch The error and return to Slack
    var response = {
      statusCode: 200,
      headers: {},
      body: exports.build_responce_body(e.message, true)
    }
    callback(null, response)
  })
}

exports.handle = (event, context, callback) => {
  if (event.path === '/pwn') {
    return exports.handle_pwn(event, callback)
  } else if (event.path === '/oauth') {
    return exports.handle_oauth(event, callback)
  } else {
    return callback(new Error(`Unknown path "${event.path}"`), null)
  }
}

/// //////////
//  HANDLE OAUTH
/// //////////

// adapted from https://github.com/girliemac/slack-httpstatuscats/blob/master/index.js
exports.authenticate = (code) => {
  return post('https://slack.com/api/oauth.access', {
    form: {
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code: code
    }
  })
}
// GET REQUEST
// {
//   "resource": "", path": "", "headers": {}, "requestContext": {}, "isBase64Encoded": false
//   "httpMethod": "GET",
//    "queryStringParameters": {
//      "code": "<code>",
//      "state": ""
//    },
//   "body": null
// }
exports.handle_oauth = (event, callback) => {
  var code = event.queryStringParameters.code

  if (!code) {
    return callback(null, {
      statusCode: 403,
      body: 'OAuth requires code param'
    })
  }

  return Promise.try(() => {
    return exports.authenticate(code)
  }).then((resp) => {
    var response = {
      statusCode: 302,
      headers: {
        Location: 'https://github.com/coinbase/pwnbot'
      }
    }
    return callback(null, response)
  }).catch((e) => {
    console.log(e)
    // Catch The error and return 400
    var response = {
      statusCode: 400,
      headers: {},
      body: e.message
    }
    callback(null, response)
  })
}
