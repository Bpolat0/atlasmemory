export const TS_QUERIES = `
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    body: (statement_block) @body) @function
  
  (class_declaration
    name: (type_identifier) @name
    body: (class_body) @body) @class

  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params
    body: (statement_block) @body) @method

  (import_statement source: (string) @import_source) @import
  (export_statement source: (string) @import_source) @import

  (interface_declaration) @interface
  (type_alias_declaration) @type

  (call_expression
    function: (identifier) @call_name) @call
  
  (call_expression
    function: (member_expression
        property: (property_identifier) @call_name)) @call
`;

export const PYTHON_QUERIES = `
  (function_definition
    name: (identifier) @name
    parameters: (parameters) @params
    body: (block) @body) @function

  (class_definition
    name: (identifier) @name
    body: (block) @body) @class

  ; (import_statement (dotted_name) @import_module) @import
  ; (import_from_statement module: (dotted_name) @import_module) @import

  (call
    function: (identifier) @call_name) @call
  
  (call
    function: (attribute
        attribute: (identifier) @call_name)) @call
`;
