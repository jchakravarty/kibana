/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { shallow } from 'enzyme';
import React from 'react';
import { UpgradeContentsComponent } from './upgrade_contents';

describe('JobsTableFilters', () => {
  test('renders correctly against snapshot', () => {
    const wrapper = shallow(<UpgradeContentsComponent />);
    expect(wrapper).toMatchSnapshot();
  });
});