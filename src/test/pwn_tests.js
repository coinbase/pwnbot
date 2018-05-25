var PwnBot = require('../index.js')
var assert = require('assert');
var _ = require("lodash")
Promise = require("bluebird")

beforeEach(() => {
  process.env.SLACK_TOKEN = 't1'

  // STUBS
  PwnBot.putItemAsync = (item) => {
    console.log(`STUB putItemAsync ${JSON.stringify(item, null, 2)}`)
    return Promise.try(() => {})
  }

  PwnBot.queryAsync = (query) => {
    console.log(`STUB queryAsync ${JSON.stringify(query,null, 2)}`)
    return Promise.try(() => {})
  }

  PwnBot.recent_pwn = (team_id, pwned) => {
    console.log(`STUB recent_pwn ${JSON.stringify([team_id, pwned],null, 2)}`)
    return Promise.try(() => false)
  }

  PwnBot.authenticate = (code) => {
    console.log(`STUB authenticate ${code}`)
    return Promise.try(() => {})
  }
})

describe("build_pwn", () => {
  it("should handle GET", () => {
    var event = {
      "httpMethod": "GET",
      "queryStringParameters": {
        "user_id": "2",
        "text": "<@U0000ID|bob>",
        "user_name": "alice",
        "team_domain": "team",
        "team_id": "1",
        "token": "ttt"
      }
    }

    var pwn = PwnBot.build_pwn(event)
    console.log(pwn)
    assert.equal(pwn.action, "CREATE")
    assert.equal(pwn.pwner, "bob")
    assert.equal(pwn.pwner_id, "U0000ID")
    assert.equal(pwn.pwned, "alice")
    assert.equal(pwn.pwned_id, "2")
    assert.equal(pwn.team_id, "1")
    assert.equal(pwn.team_domain, "team")
    assert.equal(pwn.token, "ttt")
    assert.ok(_.isFinite(Date.parse(pwn.created_at)))
    assert.ok(_.isFinite(Date.parse(pwn.expires_at)))
    assert.ok(_.isFinite(parseInt(pwn.expires_at_time)))
  })

  it("should handle POST", () => {
    var event = {
      "httpMethod": "POST",
      "body": "token=ttt&team_id=1&team_domain=team&user_id=2&user_name=alice&text=<@U0000ID|bob>%20during%20meeting",
    }

    var pwn = PwnBot.build_pwn(event)

    assert.equal(pwn.action, "CREATE")
    assert.equal(pwn.pwner, "bob")
    assert.equal(pwn.pwner_id, "U0000ID")
    assert.equal(pwn.pwned, "alice")
    assert.equal(pwn.pwned_id, "2")
    assert.equal(pwn.team_id, "1")
    assert.equal(pwn.team_domain, "team")
    assert.equal(pwn.token, "ttt")
    assert.ok(_.isFinite(Date.parse(pwn.created_at)))
    assert.ok(_.isFinite(Date.parse(pwn.expires_at)))
    assert.ok(_.isFinite(parseInt(pwn.expires_at_time)))
  })

  it("assert no text or empty text returns action GET", () => {
    var event = {
      "httpMethod": "GET",
      "queryStringParameters": {
        "text": " <@U0000ID|bob>",
      }
    }
    var pwn = PwnBot.build_pwn(event)
    assert.equal(pwn.pwner, "bob")
  })

  it("assert no text or empty text returns action GET", () => {
    var event = {
      "httpMethod": "GET",
      "queryStringParameters": {
        "text": " ",
        "team_id": "1"
      }
    }
    var pwn = PwnBot.build_pwn(event)

    assert.equal(pwn.action, "GET")
    assert.equal(pwn.team_id, "1")

    var event = {
      "httpMethod": "GET",
      "queryStringParameters": {
        "text": "",
        "team_id": "1"
      }
    }

    assert.equal(pwn.action, "GET")
    assert.equal(pwn.team_id, "1")
  })
})

describe("validate_pwn", () => {

  it("should be valid", () => {
    var basic_pwn = {
      pwner:           "pwner",
      pwned:           "pwned",
      pwner_id:           "pwner",
      pwned_id:           "pwned",
      token:           "t1"
    }

    assert.ok(PwnBot.validate_pwn(basic_pwn))
  })

  it("should be invalid if token not slack token", () => {
    var basic_pwn = {
      pwner:           "pwner",
      pwned:           "pwned",
      pwner_id:        "pwner",
      pwned_id:        "pwned",
      token:           "t2"
    }

    assert.throws( () => { PwnBot.validate_pwn(basic_pwn)})
  })

  it("should be invalid if pwned is pwner", () => {
    var basic_pwn = {
      action:          "CREATE",
      pwner:           "pwner",
      pwned:           "pwner",
      pwner_id:        "pwner",
      pwned_id:        "pwner",
      token:           "t1"
    }

    assert.throws( () => { PwnBot.validate_pwn(basic_pwn)})
  })
})

describe("collectors", () => {
  var items = [
    {pwned_user_id: "a", pwner_user_id: "c", created_at: "2000-01-01"},
    {pwned_user_id: "b", pwner_user_id: "c", created_at: "2001-01-01"},
    {pwned_user_id: "b", pwner_user_id: "a", created_at: "2002-01-01"},
    {pwned_user_id: "c", pwner_user_id: "a", created_at: "2003-01-01"},
    {pwned_user_id: "c", pwner_user_id: "b", created_at: "2004-01-01"},
    {pwned_user_id: "c", pwner_user_id: "a", created_at: "2005-01-01"}
  ]

  it("pwned_list should return ordered list of pwned", () => {
    var pwneds = PwnBot.pwned_list(items)
    assert.equal(pwneds.length, 3)
    assert.equal(pwneds[0], "c _(3)_")
    assert.equal(pwneds[1], "b _(2)_")
    assert.equal(pwneds[2], "a _(1)_")
  })


  it("pwner_list should return ordered list of pwner", () => {
    var pwners = PwnBot.pwner_list(items)
    assert.equal(pwners.length, 3)
    assert.equal(pwners[0], "a _(3)_")
    assert.equal(pwners[1], "c _(2)_")
    assert.equal(pwners[2], "b _(1)_")
  })

  it("recent_list should return ordered list of recent pwns", () => {
    var recent = PwnBot.recent_list(items)
    assert.equal(recent.length, 6)
    assert.equal(recent[0], "a pwned c 13 years ago")
    assert.equal(recent[1], "b pwned c 14 years ago")
  })

  it("data_table should return ordered list of recent pwns", () => {
    var table = PwnBot.data_table(items)
    assert.ok(_.includes(table, "c _(3)_"))
    assert.ok(_.includes(table, "a _(3)_"))
    assert.ok(_.includes(table, "a pwned c 13 years ago"))
  })

  it("data_table should return ordered and anonymized list of recent pwneess", () => {
    process.env['FRIENDSHIP_IS_MAGIC'] = "1"
    var table = PwnBot.data_table(items)
    assert.ok(! _.includes(table, "The PWNED"))
    assert.ok(_.includes(table, "The PWNERS"))
    assert.ok(_.includes(table, "RECENT"))
    assert.ok(! _.includes(table, "a pwned c 13 years ago"))
    process.env['FRIENDSHIP_IS_MAGIC'] = "0"
  })
})

describe("handle", () => {
  it("should pwn work", () => {
    var event = {
      "path": "/pwn",
      "httpMethod": "GET",
      "queryStringParameters": {
        "user_id": "2",
        "text": "<@UID0001|bob>",
        "user_name": "alice",
        "team_domain": "team",
        "team_id": "1",
        "token": "t1"
      }
    }
    var handle = Promise.promisify(PwnBot.handle)
    return handle(event, {}).then( (data) => {
      assert.equal(data.statusCode, 200)
      console.log(data)
      assert(_.includes(data.body, "lock"))
    })
  })

it("should oauth work", () => {
    var event = {
      "path": "/oauth",
      "httpMethod": "GET",
      "queryStringParameters": {
        "code": "2"
      }
    }
    var handle = Promise.promisify(PwnBot.handle)
    return handle(event, {}).then( (data) => {
      assert.equal(data.statusCode, 302)
    })
  })
})
