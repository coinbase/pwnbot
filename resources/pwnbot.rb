require 'json'
require 'tmpdir'
require 'fileutils'

########################################
###           ENVIRONMENT            ###
########################################

env = environment('pwnbot') {
  region      'us-east-1'
  account_id  ENV.fetch('AWS_ACCOUNT_ID')
}

########################################
###            UTILS                 ###
########################################

def build_zip_lambda(function_name, source_path)
  lambda_filename = File.expand_path("tmp/#{env.name}/#{function_name}.zip")
  tmp_dir = Dir.mktmpdir
  FileUtils.copy_entry(source_path, tmp_dir)
  Dir.chdir(tmp_dir) do
    # Install the node modules
    system("rm", "-rf", "node_modules")
    system("npm", "install", "--production")

    system("zip", "-FSr", lambda_filename, ".")
  end

  return lambda_filename
end

########################################
###            PROJECT               ###
########################################

project = project('coinbase', 'pwnbot') {
  environments 'pwnbot'
  tags {
    ProjectName "coinbase/pwnbot"
    self[:org] = "coinbase"
    self[:project] = "pwnbot"
  }
}

lambda_name = "#{project.org}_#{project.name}"
role_name = "#{lambda_name}_role"

########################################
###         Persistence              ###
########################################

project.dynamo_table = project.resource("aws_dynamodb_table", "pwnbot-pwned") {
  name            "pwnbot-pwned"
  read_capacity   1
  write_capacity  1
  hash_key        "team_id"
  range_key       "created_at"

  attribute {
    name "team_id"
    self["type"] = "S"
  }

  attribute {
    name "created_at"
    self["type"] = "S"
  }

  ttl {
    attribute_name "expires_at_time"
    enabled true
  }
}

########################################
###         IAM  Role                ###
########################################

role = project.resource('aws_iam_role', role_name) {
  name role_name
  path "/"
  assume_role_policy(
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Sid": "",
          "Effect": "Allow",
          "Principal": {
            "Service": [
              "lambda.amazonaws.com",
              "apigateway.amazonaws.com"
            ]
          },
          "Action": "sts:AssumeRole"
        }
      ]
    }.to_json
  )
}

project.resource('aws_iam_role_policy', role_name) {
  name role_name
  role role_name
  depends_on [role.terraform_name, project.dynamo_table.terraform_name]
  policy(
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ],
          "Resource": "arn:aws:logs:*:*:log-group:/aws/lambda/*"
        },
        {
          "Effect": "Allow",
          "Action": [
            "dynamodb:DescribeTable",
            "dynamodb:PutItem",
            "dynamodb:GetItem",
            "dynamodb:Query"
          ],
          "Resource": [
            "arn:aws:dynamodb:us-east-1:#{env.account_id}:table/#{project.dynamo_table.name}"
          ]
        }
      ]
    }.to_json
  )
}

########################################
###            Lambda                ###
########################################

lambda_function = project.resource("aws_lambda_function", lambda_name) {
  _zip_path build_zip_lambda(lambda_name, "./src")

  function_name lambda_name
  description lambda_name

  role role.to_ref('arn')

  lifecycle {
    ignore_changes ["environment"]
  }

  handler "index.handle"
  memory_size 512
  runtime "nodejs6.10"
  timeout "30"
  filename -> { _zip_path }
  source_code_hash -> { %[${base64sha256(file("#{_zip_path}"))}] }
  publish "true"
}

project.resource("aws_lambda_permission", lambda_name) {
  statement_id "Allow_api_Gateway_to_execute_#{lambda_name}"
  function_name lambda_name
  action "lambda:InvokeFunction"
  principal "apigateway.amazonaws.com"
  depends_on [lambda_function.terraform_name]
}

########################################
###         API Gateway              ###
########################################

json_rest_api = project.from_template("json_rest_api", lambda_name, {
  lambda: {
    pwnbot: lambda_function
  },
  methods: {
    create: {
      path: 'pwn',
      method: "GET",
      api_key: false,
      auth: "NONE",
      handler: :pwnbot # reference to lambda above
    },
    createp: {
      path: 'pwn',
      method: "POST",
      api_key: false,
      auth: "NONE",
      handler: :pwnbot # reference to lambda above
    },
    oauth: {
      path: 'oauth',
      method: "GET",
      api_key: false,
      auth: "NONE",
      handler: :pwnbot # reference to lambda above
    }
  }
})

rest_api = json_rest_api.rest_api

# Deployments Every time a change is made a new deployment needs to be made
deployment_stage = project.resource("aws_api_gateway_deployment", "#{lambda_name}_prod_deployment") {
  _rest_api rest_api
  depends_on rest_api.all_core_api_resources.map(&:terraform_name)
  stage_name "api"
  description ""
  lifecycle {
    ignore_changes "description"
  }
}

project.resource("aws_api_gateway_usage_plan", "basic_usage_plan") {
  name "BasicPwnBotPlan"
  description "Basic PwnBot Plan"

  api_stages {
    api_id rest_api.to_ref
    stage  "api"
  }

  depends_on [deployment_stage, rest_api].map(&:terraform_name)
}
