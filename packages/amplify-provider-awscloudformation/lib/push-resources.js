const fs = require('fs');
const path = require('path');
const cfnLint = require('cfn-lint');
const S3 = require('../src/aws-utils/aws-s3');
const Cloudformation = require('../src/aws-utils/aws-cfn');
const providerName = require('./constants').ProviderName;
const { buildResource } = require('./build-resources');

const nestedStackFileName = 'nested-cloudformation-stack.yml';

function run(context, category, resourceName) {
  const {
    resourcesToBeCreated,
    resourcesToBeUpdated,
    resourcesToBeDeleted,
  } = context.amplify.getResourceStatus(category, resourceName);
  const resources = resourcesToBeCreated.concat(resourcesToBeUpdated);
  let projectDetails = context.amplify.getProjectDetails();

  validateCfnTemplates(context, resources);

  return packageResources(context, resources)
    .then(() => updateS3Templates(context, resources, projectDetails.amplifyMeta))
    .then(() => {
      projectDetails = context.amplify.getProjectDetails();
      if (resources.length > 0 || resourcesToBeDeleted.length > 0) {
        return updateCloudFormationNestedStack(
          context,
          formNestedStack(projectDetails.amplifyMeta), resourcesToBeDeleted,
        );
      }
    })
    .then(() => {
      if (resources.length > 0) {
        context.amplify.updateamplifyMetaAfterPush(resources);
      }
      for (let i = 0; i < resourcesToBeDeleted.length; i += 1) {
        context.amplify.updateamplifyMetaAfterResourceDelete(
          resourcesToBeDeleted[i].category,
          resourcesToBeDeleted[i].resourceName,
        );
      }
    });
}

function validateCfnTemplates(context, resourcesToBeUpdated) {
  for (let i = 0; i < resourcesToBeUpdated.length; i += 1) {
    const { category, resourceName } = resourcesToBeUpdated[i];
    const backEndDir = context.amplify.pathManager.getBackendDirPath();
    const resourceDir = path.normalize(path.join(backEndDir, category, resourceName));
    const files = fs.readdirSync(resourceDir);
    // Fetch all the Cloudformation templates for the resource (can be json or yml)
    const cfnFiles = files.filter(file => ((file.indexOf('yml') !== -1) || (file.indexOf('json') !== -1)));
    for (let j = 0; j < cfnFiles.length; j += 1) {
      const filePath = path.normalize(path.join(resourceDir, cfnFiles[j]));
      try {
        cfnLint.validateFile(filePath);
      } catch (err) {
        context.print.error(`Invalid Cloudformation tempalte: ${filePath}`);
        throw err;
      }
    }
  }
}

function packageResources(context, resources) {
  // Only build and package resources which are required
  resources = resources.filter(resource => resource.build);

  const packageResource = (context, resource) => {
    let s3Key;
    return buildResource(context, resource)
      .then((result) => {
        ({ zipFilename } = result);
        // Upload zip file to S3
        s3Key = `ampify-builds/${result.zipFilename}`;
        return new S3(context)
          .then((s3) => {
            const s3Params = {
              Body: fs.createReadStream(result.zipFilePath),
              Key: s3Key,
            };
            return s3.uploadFile(s3Params);
          });
      })
      .then((s3Bucket) => {
      // Update cfn template
        const { category, resourceName } = resource;
        const backEndDir = context.amplify.pathManager.getBackendDirPath();
        const resourceDir = path.normalize(path.join(backEndDir, category, resourceName));

        const files = fs.readdirSync(resourceDir);
        // Fetch all the Cloudformation templates for the resource (can be json or yml)
        const cfnFiles = files.filter(file => ((file.indexOf('yml') !== -1) || (file.indexOf('json') !== -1)));

        if (cfnFiles.length !== 1) {
          context.print.error('There should be just one cloudformation template in the resource directory');
          context.print.error(resourceDir);
          throw new Error('There should be just one cloudformation template in the resource directory');
        }

        const cfnFile = cfnFiles[0];
        const cfnFilePath = path.normalize(path.join(resourceDir, cfnFile));

        const cfnMeta = JSON.parse(fs.readFileSync(cfnFilePath));

        cfnMeta.Resources.LambdaFunction.Properties.Code = {
          S3Bucket: s3Bucket,
          S3Key: s3Key,
        };

        const jsonString = JSON.stringify(cfnMeta, null, '\t');
        fs.writeFileSync(cfnFilePath, jsonString, 'utf8');
      });
  };

  const promises = [];
  for (let i = 0; i < resources.length; i += 1) {
    promises.push(packageResource(context, resources[i]));
  }

  return Promise.all(promises);
}


function updateCloudFormationNestedStack(context, nestedStack) {
  const backEndDir = context.amplify.pathManager.getBackendDirPath();
  const nestedStackFilepath = path.normalize(path.join(
    backEndDir,
    providerName,
    nestedStackFileName,
  ));

  const jsonString = JSON.stringify(nestedStack, null, '\t');
  context.filesystem.write(nestedStackFilepath, jsonString);

  return new Cloudformation(context)
    .then(cfnItem => cfnItem.updateResourceStack(
      path.normalize(path.join(backEndDir, providerName)),
      nestedStackFileName,
    ));
}

function updateS3Templates(context, resourcesToBeUpdated, amplifyMeta) {
  const promises = [];

  for (let i = 0; i < resourcesToBeUpdated.length; i += 1) {
    const { category, resourceName } = resourcesToBeUpdated[i];
    const backEndDir = context.amplify.pathManager.getBackendDirPath();
    const resourceDir = path.normalize(path.join(backEndDir, category, resourceName));
    const files = fs.readdirSync(resourceDir);
    // Fetch all the Cloudformation templates for the resource (can be json or yml)
    const cfnFiles = files.filter(file => ((file.indexOf('yml') !== -1) || (file.indexOf('json') !== -1)));

    for (let j = 0; j < cfnFiles.length; j += 1) {
      promises.push(uploadTemplateToS3(
        context,
        resourceDir,
        cfnFiles[j],
        category,
        resourceName,
        amplifyMeta,
      ));
    }
  }

  return Promise.all(promises);
}

function uploadTemplateToS3(context, resourceDir, cfnFile, category, resourceName, amplifyMeta) {
  const filePath = path.normalize(path.join(resourceDir, cfnFile));
  let s3Key;

  return new S3(context)
    .then((s3) => {
      const s3Params = {
        Body: fs.createReadStream(filePath),
        Key: `amplify-cfn-templates/${cfnFile}`,
      };
      return s3.uploadFile(s3Params);
    })
    .then((projectBucket) => {
      const templateURL = `https://s3.amazonaws.com/${projectBucket}/amplify-cfn-templates/${cfnFile}`;
      const providerMetadata = amplifyMeta[category][resourceName].providerMetadata || {};
      providerMetadata.s3TemplateURL = templateURL;
      providerMetadata.logicalId = category + resourceName;
      context.amplify.updateamplifyMetaAfterResourceUpdate(category, resourceName, 'providerMetadata', providerMetadata);
    });
}

function formNestedStack(amplifyMeta) {
  const nestedStack = JSON.parse(fs.readFileSync(`${__dirname}/rootStackTemplate.json`));

  let categories = Object.keys(amplifyMeta);
  categories = categories.filter(category => category !== 'provider');
  categories.forEach((category) => {
    const resources = Object.keys(amplifyMeta[category]);

    resources.forEach((resource) => {
      const resourceDetails = amplifyMeta[category][resource];
      const resourceKey = category + resource;
      let templateURL;
      if (resourceDetails.providerMetadata) {
        const parameters = {};
        const { dependsOn } = resourceDetails;

        if (dependsOn) {
          for (let i = 0; i < dependsOn.length; i += 1) {
            for (let j = 0; j < dependsOn[i].attributes.length; j += 1) {
              const parameterKey = dependsOn[i].category +
              dependsOn[i].resourceName +
              dependsOn[i].attributes[j];
              const dependsOnStackName = dependsOn[i].category + dependsOn[i].resourceName;

              parameters[parameterKey] = { 'Fn::GetAtt': [dependsOnStackName, `Outputs.${dependsOn[i].attributes[j]}`] };
            }
          }
        }

        templateURL = resourceDetails.providerMetadata.s3TemplateURL;
        nestedStack.Resources[resourceKey] = {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: templateURL,
            Parameters: parameters,
          },
        };
      }
    });
  });
  return nestedStack;
}

module.exports = {
  run,
};
